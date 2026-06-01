import {
  COMPACTOR_FALLBACK_MODEL,
  COMPACTOR_MODEL,
  meteredGenerateText,
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
 *   - The new system message carries an ephemeral 1h Anthropic
 *     `cacheControl` annotation (ADR-0026's reserved third breakpoint).
 *     Gemini and other providers ignore the namespaced metadata
 *     silently, so the same construction is safe across the
 *     swap-back-to-Anthropic window in `provider.ts`.
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

export async function compactTranscript(
  args: CompactTranscriptArgs,
): Promise<CompactTranscriptResult> {
  const { prior, inFlightTail, attribution } = args;
  const model = await selectCompactorModel(prior);

  const providerOptions = providerOptionsFor(model);
  const result = await meteredGenerateText(
    {
      model,
      maxOutputTokens: 2000,
      temperature: 0,
      system: COMPACTOR_SYSTEM_PROMPT,
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
  if (priorTokens <= compactorWindow) return COMPACTOR_MODEL;

  const fallbackWindow = await resolveModelContextWindow(COMPACTOR_FALLBACK_MODEL);
  if (priorTokens <= fallbackWindow) return COMPACTOR_FALLBACK_MODEL;

  throw new Error("compactor_input_too_large");
}

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
 * Build the `<run_summary>` system message with an ephemeral 1h Anthropic
 * cache breakpoint. Wrapping the model output in the same XML tag the
 * prompt instructs the model to emit (`<run_summary>...</run_summary>`)
 * would double-wrap; the prompt already requires the model to emit the
 * outer element, so we trust the model's output verbatim.
 */
function buildSummaryMessage(text: string): AgentTranscriptMessage {
  return {
    role: "system",
    content: text,
    providerOptions: {
      anthropic: {
        cacheControl: { type: "ephemeral", ttl: "1h" },
      },
    },
  };
}
