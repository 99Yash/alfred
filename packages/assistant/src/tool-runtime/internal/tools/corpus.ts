import { corpusSearchInput } from "@alfred/contracts";
import type { RegisteredTool } from "@alfred/assistant/tool-runtime";
import { liveTool } from "@alfred/assistant/tool-runtime";

/**
 * `system.corpus_search` — read-only semantic search over the user's ingested
 * document corpus (ADR-0091 D8). The corpus dependency rides the execute
 * context (`ctx.corpus.search`, built in `../../context`), so this module
 * never imports `@alfred/db` or `@alfred/corpus` and the tool graph stays free
 * of the static database edge.
 */
export const corpusTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "system",
    action: "corpus_search",
    // Bounded local read with no external side effect; like web_search,
    // `system.*` tools dispatch in autonomy mode so this never awaits approval.
    riskTier: "no_risk",
    staging: "fast_path",
    // Lazy (not kernel): the per-prompt kernel budget is a tight ratchet and
    // the ladder (search_tools/load_tool) discovers this tool on demand. The
    // description carries the selection work.
    description:
      "Search the user's personal document corpus — everything Alfred has ingested: emails, email attachments (PDFs included), and connected-source documents. Returns ranked passages with their source, title, date, and, for PDFs, the exact page number the passage sits on (cite it as 'page N'; non-PDF hits carry no page and you must not invent one). Use this for anything that lives in the user's own records — 'what does my resume say about X', 'find the contract clause about termination', 'which email mentioned the invoice number'. For live public information use web_search instead; to open a specific known URL use fetch_url.",
    inputSchema: corpusSearchInput,
    execute: async (input, ctx) => {
      const hits = await ctx.corpus.search({ query: input.query, userId: ctx.userId });
      return { ok: true, query: input.query, hits };
    },
  }),
];
