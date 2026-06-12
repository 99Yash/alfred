import { tool, type ToolSet } from "@alfred/ai";
import { z } from "zod";
import { runWebSearch } from "../tools/web-search";

/**
 * A local `web_search` tool for cold-start's bounded agent loops (seed +
 * aspect sub-agents). Each call delegates to {@link runWebSearch} — the same
 * grounded-Gemini path the boss/sub-agents use at runtime — so every search
 * lands its own `api_call_log` row tagged `kind='web_search'` while the
 * surrounding reasoning turn is a single `kind='llm'` row.
 *
 * Why local-execute rather than `system.spawn_sub_agent`: cold-start is a
 * deterministic onboarding workflow, not a boss-driven autonomous run. We want
 * the agent harness (a model that picks its own queries and adapts to what it
 * finds), but bounded — `meteredGenerateText` + `stopWhen(stepCountIs(n))`
 * gives exactly that without the separate `agent_runs` / queue / dispatch
 * machinery the spawn path carries, which is far too heavy and slow for a
 * signup callback.
 *
 * The returned `citations` array is mutated in place across the loop: every
 * search appends its (deduped, order-preserving) source URLs so the caller can
 * read the full citation set after the loop finishes.
 */
export interface ColdStartWebTool {
  /** Pass straight to `meteredGenerateText`'s `tools`. */
  tools: ToolSet;
  /** Deduped citation URLs collected across every search this loop ran. */
  citations: string[];
  /** How many searches actually executed — for step logging. */
  searchCount: () => number;
}

export function buildColdStartWebTool(args: {
  userId: string;
  runId: string;
  stepId: string;
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
        // Stable per-search key so a retried turn re-uses the same trace id.
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
