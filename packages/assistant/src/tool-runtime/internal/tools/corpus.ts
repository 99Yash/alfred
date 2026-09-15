import { corpusSearchInput } from "@alfred/contracts";
import type { SearchHit } from "@alfred/corpus";
import type { RegisteredTool } from "@alfred/assistant/tool-runtime";
import { liveTool } from "@alfred/assistant/tool-runtime";

/**
 * `system.corpus_search` — read-only semantic search over the user's ingested
 * document corpus (ADR-0091 D8). The corpus dependency rides the execute
 * context (`ctx.corpus.search`, built in `../../context`), so this module takes
 * no runtime dependency on `@alfred/db` or `@alfred/corpus` and the tool graph
 * stays free of the static database edge. The one `@alfred/corpus` import here
 * is `import type`, which TypeScript erases, so it adds no such edge — the same
 * form the runtime registry already uses to type the bind.
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
      "Search the user's personal document corpus — everything Alfred has ingested: emails, email attachments (PDFs included), GitHub and Sentry activity, and connected-source documents. Activity hits carry the provider in `source`, the receipt `kind`, and a `url` when the provider supplied a link; use that URL when citing the event. Use this for questions such as what happened in Sentry this week or what changed on my pull requests yesterday. Returns ranked passages with their source, title, date, and, for PDFs, the exact page number the passage sits on (cite it as 'page N'; non-PDF hits carry no page and you must not invent one). Attachment hits may also carry `occurrences`: every email that carried byte-identical content of that file (filename, mimeType, threadId), so a hit titled by one carrier can be matched to another name the user mentions. Use this for anything that lives in the user's own records — 'what does my resume say about X', 'find the contract clause about termination', 'which email mentioned the invoice number'. For live public information use web_search instead; to open a specific known URL use fetch_url.",
    inputSchema: corpusSearchInput,
    execute: async (input, ctx) => {
      const hits = await ctx.corpus.search({ query: input.query, userId: ctx.userId });

      return { ok: true, query: input.query, hits: hits.map(modelFacingHit) };
    },
  }),
];

/**
 * One hit as the model reads it: exactly the fields the description above
 * promises.
 *
 * #1076 put the record identity on `SearchHit` — the provider's own id, the
 * connected account, the thread — for the evidence-card expansion handle a
 * live drill-down (#428) dereferences. That is dereference plumbing, and
 * `accountId` names a credential row, so none of it belongs in a tool result.
 * Dropping it here keeps this tool's answer byte-identical to the one it gave
 * before that change: handing the model a provider message id is a deliberate
 * decision, not a side effect of widening a shared hit.
 */
function modelFacingHit(
  hit: SearchHit,
): Omit<SearchHit, "sourceId" | "sourceThreadId" | "accountId"> {
  const { sourceId: _sourceId, sourceThreadId: _threadId, accountId: _accountId, ...rest } = hit;

  return rest;
}
