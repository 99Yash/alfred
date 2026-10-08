import { tool, type ToolSet } from "@alfred/ai";
import { z } from "zod";
import { runWebSearch } from "../web-search";

/**
 * A local `web_search` tool for cold-start's capped agent loops. It calls `runWebSearch`,
 * so each search logs its own `api_call_log` row. It avoids `system.spawn_sub_agent`,
 * which is too slow for a signup callback. `citations` grows in place across the loop.
 */
export interface ColdStartWebTool {
  tools: ToolSet;
  citations: string[];
  searchCount: () => number;
}

export function buildColdStartWebTool(args: {
  userId: string;
  /** An omitted run meters as null, not "". */
  runId?: string | undefined;
  stepId?: string | undefined;
  abortSignal?: AbortSignal | undefined;
}): ColdStartWebTool {
  const citations: string[] = [];
  const seen = new Set<string>();
  let count = 0;

  const webSearch = tool({
    description:
      "Search the live web and get back a short, cited answer. Use focused, specific queries; pair the subject's full name with a distinguishing detail (employer, city, handle, domain) so results disambiguate from other people with the same name.",
    inputSchema: z.object({
      query: z.string().min(1).max(300).describe("A focused web search query."),
    }),
    execute: async ({ query }, { toolCallId }) => {
      count++;

      const { answer, citations: cites } = await runWebSearch({
        query,
        userId: args.userId,
        runId: args.runId,
        stepId: args.stepId,
        abortSignal: args.abortSignal,
        idempotencyKey: toolCallId,
      });

      for (const c of cites) {
        if (c.url && !seen.has(c.url)) {
          seen.add(c.url);
          citations.push(c.url);
        }
      }

      return { answer, citations: cites };
    },
  });

  return { tools: { web_search: webSearch }, citations, searchCount: () => count };
}
