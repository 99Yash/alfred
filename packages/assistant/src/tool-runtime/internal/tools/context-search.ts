import { searchContextInput } from "@alfred/contracts";
import type { RegisteredTool } from "@alfred/assistant/tool-runtime";
import { liveTool, runContextSearch } from "@alfred/assistant/tool-runtime";

/**
 * `system.search_context` — the model-facing door to the Context Search read
 * boundary (epic #422; ADR-0101).
 *
 * The tool is a thin adapter: it forwards the model's bounded envelope (plus
 * the call's `userId`) through the `SystemToolContextSearchAdapter` boot seam,
 * which runs `searchContext` over every registered source and packs the result
 * with `packEvidenceCards`. This file never imports `@alfred/assistant/context-search`
 * — its adapters reach the database and corpus, and the tool graph every
 * declaration imports must stay free of those edges (ADR-0089). The seam is
 * installed by runtime composition.
 *
 * Read-only by construction: `fast_path` (no staging row, no approval — the
 * boundary never writes) and `no_risk`. The result the model sees is packed,
 * cited, bounded text with per-source missing/failed notes, never a raw provider
 * body or a media byte. An empty read is a successful empty read, not a failure:
 * it must not stop the model from drilling into a provider-specific tool.
 */
export const contextSearchTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "system",
    action: "search_context",
    // Bounded read with no external side effect; like corpus_search, `system.*`
    // tools dispatch in autonomy mode so this never awaits approval.
    riskTier: "no_risk",
    staging: "fast_path",
    // Kernel: the chat prompt names this as the first-pass way to assemble
    // evidence across sources, so it must be visible on turn one — otherwise
    // every first use pays a search/load dance plus a mid-run prompt-cache
    // invalidation. The #414 budget ratchet records the cost deliberately.
    availability: { surface: "kernel" },
    description:
      "One bounded read across Alfred's evidence sources at once: your memory of the user, their ingested documents and attachments, and known work-object state. Use it as the first pass for a question that may need evidence assembled across sources — 'what do we know about X', 'what did Y change last week'. It returns bounded, cited snippets with a note for any source that had nothing or failed; never full documents or media bytes. For an action or an exact record, use the provider-specific tools (gmail.*, drive.*, github.*, calendar.*, …). An empty or thin result is a real answer, not a dead end: drill into a provider or the live web next.",
    inputSchema: searchContextInput,
    execute: async (input, ctx) => {
      return await runContextSearch({
        input,
        context: {
          userId: ctx.userId,
          runId: ctx.runId,
          stepId: ctx.stepId,
          toolCallId: ctx.toolCallId,
        },
      });
    },
  }),
];
