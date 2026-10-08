import { searchContextInput } from "@alfred/contracts";
import type { RegisteredTool } from "@alfred/assistant/tool-runtime";
import { liveTool, runContextSearch } from "@alfred/assistant/tool-runtime";

/**
 * `system.search_context` (ADR-0101). Forwards through the `SystemToolContextSearchAdapter`
 * seam, because `@alfred/assistant/context-search` reaches the database (ADR-0089).
 * An empty read is a success, so the model can still drill into a provider tool.
 */
export const contextSearchTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "system",
    action: "search_context",
    riskTier: "no_risk",
    staging: "fast_path",
    // Kernel: the chat prompt names it as the first pass, so it must exist on turn one.
    availability: { surface: "kernel" },
    description:
      "One bounded read across Alfred's evidence sources at once: your memory of the user, their ingested documents and attachments, known work-object state, and live Drive files. Use it as the first pass for a question that may need evidence assembled across sources — 'what do we know about X', 'what did Y change last week'. It returns bounded, cited snippets with a note for any source that had nothing, failed, or was not consulted for this question (a source that only answers a different kind of question is skipped, which is different from finding nothing); never full documents or media bytes. For an action, use the provider-specific tools (gmail.*, drive.*, github.*, calendar.*, …). An empty or thin result is a real answer, not a dead end: drill into a provider or the live web next.",
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
