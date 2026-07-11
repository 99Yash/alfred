import {
  COMPACTOR_FALLBACK_MODEL,
  COMPACTOR_MODEL,
  meteredGenerateText,
  requestFitsContextWindow,
  resolveModelContextWindow,
  type AttributedCall,
  type ModelMessage,
} from "@alfred/ai";
import type { AgentTranscriptMessage } from "@alfred/contracts";
import { assertHandoffSections } from "./handoff";
import { COMPACTOR_SYSTEM_PROMPT } from "./prompt";
import { estimateTranscriptTokens } from "./tokens";

/**
 * Replace `prior` with a structured `<run_summary>` system message and
 * pin `inFlightTail` verbatim afterward (ADR-0035). The caller — the
 * `compact-transcript` step in `userAuthoredBriefWorkflow` — feeds the
 * result back into `agent_runs.transcript`.
 *
 * Shape contract:
 *   - One metered LLM round-trip via `COMPACTOR_MODEL`, falling over to
 *     `COMPACTOR_FALLBACK_MODEL` only when the prior slice exceeds the
 *     primary compactor's context window.
 *   - The new system message carries NO `cacheControl` breakpoint of its
 *     own — it lands as `transcript[0]` where `decorateTranscript` owns all
 *     transcript breakpoints (and a breakpoint here would overflow
 *     Anthropic's 4-cap on a compacted tool-burst turn, silently evicting
 *     the tool-definition cache). See `buildSummaryMessage`.
 *   - `inFlightTail` is appended unchanged. The caller decides which
 *     suffix counts as "in-flight" via `state.inFlightTailStart`.
 *
 * Throws `compactor_input_too_large` when the prior slice exceeds even
 * the fallback window. The caller lets that reason surface directly.
 * Other compactor call failures are retried by the workflow and then
 * surfaced as `compactor_failed: <msg>`.
 */
export interface CompactTranscriptArgs {
  prior: AgentTranscriptMessage[];
  inFlightTail: AgentTranscriptMessage[];
  /**
   * Per-call attribution merged into the metered row. Caller supplies
   * `userId` / `runId` / `stepId` / `attempt`; the compactor stamps
   * `role: 'compactor'` and `kind: 'llm'` itself so call sites can't
   * accidentally bucket the spend into the wrong rollup.
   */
  attribution: Omit<AttributedCall, "role" | "kind">;
}

export interface CompactTranscriptResult {
  transcript: AgentTranscriptMessage[];
  summary: AgentTranscriptMessage;
  raw: { text: string; inputTokens: number | undefined; outputTokens: number | undefined };
}

/**
 * Reserved output budget for the compaction round-trip. Named so the
 * model-selection fit check (`selectCompactorModel`) reserves the exact same
 * headroom it later sends as `maxOutputTokens` — the two must not drift.
 */
export const COMPACTOR_MAX_OUTPUT_TOKENS = 2000;

/**
 * Tokens that ride along in the compaction request on top of the `prior`
 * slice, which `selectCompactorModel` must reserve before comparing to a model
 * window (#371). Without this the fit check compares a bare `prior` estimate to
 * the full window and ignores everything else in the same request, so a `prior`
 * sized just under the window produces `prior + system + wrapper + output >
 * window` → a deterministic provider 400 that the workflow retries 3× and then
 * fails the run; the opposite boundary silently routes to the full-price
 * fallback. Components:
 *   - system prompt: `COMPACTOR_SYSTEM_PROMPT`, sent as `system`.
 *   - wrapper prose: the fixed prefix `transcriptPayloadMessage` wraps around
 *     the JSON payload (the JSON itself is already in the `prior` estimate).
 *   - output: the reserved `maxOutputTokens` above.
 * chars/4 mirrors `estimateTranscriptTokens`; the wrapper is a small constant.
 */
const COMPACTOR_FIXED_INPUT_OVERHEAD_TOKENS = Math.ceil(COMPACTOR_SYSTEM_PROMPT.length / 4) + 64;

export async function compactTranscript(
  args: CompactTranscriptArgs,
): Promise<CompactTranscriptResult> {
  const { prior, inFlightTail, attribution } = args;
  const model = await selectCompactorModel(prior);

  const providerOptions = providerOptionsFor(model);
  const result = await meteredGenerateText(
    {
      model,
      maxOutputTokens: COMPACTOR_MAX_OUTPUT_TOKENS,
      temperature: 0,
      instructions: COMPACTOR_SYSTEM_PROMPT,
      messages: [transcriptPayloadMessage(prior)] as ModelMessage[],
      ...(providerOptions ? { providerOptions: providerOptions as Record<string, never> } : {}),
    },
    {
      ...attribution,
      kind: "llm",
      role: "compactor",
    },
  );

  const text = assertRunSummary(result.text);
  const summary = buildSummaryMessage(text);
  return {
    transcript: [summary, ...inFlightTail],
    summary,
    raw: {
      text,
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
    },
  };
}

function transcriptPayloadMessage(
  prior: readonly AgentTranscriptMessage[],
): AgentTranscriptMessage {
  return {
    role: "user",
    content: `Compact this Alfred transcript JSON. Preserve IDs and tool outcomes exactly where the system prompt requires them.\n\n${JSON.stringify(prior)}`,
  };
}

async function selectCompactorModel(
  prior: readonly AgentTranscriptMessage[],
): Promise<typeof COMPACTOR_MODEL> {
  const priorTokens = estimateTranscriptTokens(prior);
  const compactorWindow = await resolveModelContextWindow(COMPACTOR_MODEL);
  if (
    requestFitsContextWindow(priorTokens, {
      contextWindowTokens: compactorWindow,
      outputReserveTokens: COMPACTOR_MAX_OUTPUT_TOKENS,
      fixedInputOverheadTokens: COMPACTOR_FIXED_INPUT_OVERHEAD_TOKENS,
    })
  ) {
    return COMPACTOR_MODEL;
  }
  const fallbackWindow = await resolveModelContextWindow(COMPACTOR_FALLBACK_MODEL);
  return chooseCompactorModel({ priorTokens, compactorWindow, fallbackWindow });
}

/**
 * Pure fit decision, split out so the window-headroom math (#371) is unit
 * testable without resolving live model windows. Reserves
 * `COMPACTOR_REQUEST_OVERHEAD_TOKENS` on top of the `prior` estimate — the
 * whole point of this function is "does the real request fit", so it must
 * account for everything the request carries beyond `prior`.
 */
export function chooseCompactorModel(args: {
  priorTokens: number;
  compactorWindow: number;
  fallbackWindow: number;
}): typeof COMPACTOR_MODEL {
  const budget = {
    outputReserveTokens: COMPACTOR_MAX_OUTPUT_TOKENS,
    fixedInputOverheadTokens: COMPACTOR_FIXED_INPUT_OVERHEAD_TOKENS,
  };
  if (
    requestFitsContextWindow(args.priorTokens, {
      ...budget,
      contextWindowTokens: args.compactorWindow,
    })
  ) {
    return COMPACTOR_MODEL;
  }
  if (
    requestFitsContextWindow(args.priorTokens, {
      ...budget,
      contextWindowTokens: args.fallbackWindow,
    })
  ) {
    return COMPACTOR_FALLBACK_MODEL;
  }
  throw new Error("compactor_input_too_large");
}

/** Exported for the headroom regression test (#371). */
export const compactorRequestOverheadTokens =
  COMPACTOR_FIXED_INPUT_OVERHEAD_TOKENS + COMPACTOR_MAX_OUTPUT_TOKENS;

function providerOptionsFor(model: typeof COMPACTOR_MODEL): Record<string, unknown> | undefined {
  if (model !== COMPACTOR_MODEL) return undefined;
  return {
    anthropic: {
      thinking: { type: "disabled" },
    },
  };
}

/**
 * Enforce the handoff contract: the model output must be a single
 * `<run_summary>...</run_summary>` element with every required inner
 * section present. Markdown fences and surrounding whitespace are
 * tolerated and stripped — the model occasionally wraps XML in ```xml
 * fences even when told not to. Anything else throws so the caller's
 * bounded retry loop sees it (one bad compactor sample shouldn't tank
 * the run, but a malformed envelope MUST NOT silently replace the prior
 * transcript).
 */
function assertRunSummary(raw: string): string {
  const trimmed = stripCodeFences(raw).trim();
  if (!trimmed.startsWith("<run_summary>") || !trimmed.endsWith("</run_summary>")) {
    const preview = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
    throw new Error(
      `compactor_invalid_output: expected one <run_summary>…</run_summary> element, got: ${preview}`,
    );
  }
  assertHandoffSections(trimmed);
  return trimmed;
}

function stripCodeFences(text: string): string {
  const fence = /^\s*```(?:xml)?\s*([\s\S]*?)\s*```\s*$/i;
  const match = fence.exec(text);
  return match ? (match[1] ?? text) : text;
}

/**
 * Build the `<run_summary>` system message. Wrapping the model output in the
 * same XML tag the prompt instructs the model to emit
 * (`<run_summary>...</run_summary>`) would double-wrap; the prompt already
 * requires the model to emit the outer element, so we trust the model's
 * output verbatim.
 *
 * This message carries NO `cacheControl` breakpoint of its own. It lands as
 * `transcript[0]` on the compacted boss path, where `decorateTranscript`
 * (packages/ai/src/agent.ts) owns all transcript breakpoints. A dedicated
 * breakpoint here would push a compacted, tool-burst-ending turn to 5
 * breakpoints (system + summary + burst-boundary + last-message + last-tool)
 * — over Anthropic's cap of 4 — and the provider silently evicts the
 * *tool definitions* (the largest, most valuable static prefix) rather than
 * 400ing. The summary still caches: `decorateTranscript`'s moving last-message
 * breakpoint cache-writes the whole prefix (this message included) each turn.
 */
function buildSummaryMessage(text: string): AgentTranscriptMessage {
  return {
    role: "system",
    content: text,
  };
}
