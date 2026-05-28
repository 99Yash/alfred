import {
  getCheapModel,
  meteredGenerateText,
  type AttributedCall,
  type ModelMessage,
} from "@alfred/ai";
import type { AgentTranscriptMessage } from "@alfred/contracts";
import { COMPACTOR_SYSTEM_PROMPT } from "./prompt";

/**
 * Replace `prior` with a structured `<run_summary>` system message and
 * pin `inFlightTail` verbatim afterward (ADR-0035). The caller — the
 * `compact-transcript` step in `userAuthoredBriefWorkflow` — feeds the
 * result back into `agent_runs.transcript`.
 *
 * Shape contract:
 *   - One metered LLM round-trip via `getCheapModel()` with
 *     `role: 'compactor'`, capped at 2000 output tokens.
 *   - The new system message carries an ephemeral 1h Anthropic
 *     `cacheControl` annotation (ADR-0026's reserved third breakpoint).
 *     Gemini and other providers ignore the namespaced metadata
 *     silently, so the same construction is safe across the
 *     swap-back-to-Anthropic window in `provider.ts`.
 *   - `inFlightTail` is appended unchanged. The caller decides which
 *     suffix counts as "in-flight" via `state.inFlightTailStart`.
 *
 * Throws when the compactor call fails. The caller wraps this in a
 * bounded retry loop and surfaces a terminal `compactor_failed: <msg>`
 * after exhaustion — explicit failure is preferable to silently running
 * the boss with an overflowing context window.
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

  const result = await meteredGenerateText(
    {
      model: getCheapModel(),
      maxOutputTokens: 2000,
      system: COMPACTOR_SYSTEM_PROMPT,
      messages: prior as ModelMessage[],
    },
    {
      ...attribution,
      kind: "llm",
      role: "compactor",
    },
  );

  const summary = buildSummaryMessage(result.text);
  return {
    transcript: [summary, ...inFlightTail],
    summary,
    raw: {
      text: result.text,
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
    },
  };
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
