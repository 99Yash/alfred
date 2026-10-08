import { corpusSearchInput } from "@alfred/contracts";
import type { ModelFacingHit } from "@alfred/corpus";
import type { RegisteredTool } from "@alfred/assistant/tool-runtime";
import { liveTool } from "@alfred/assistant/tool-runtime";

/**
 * `system.corpus_search`: semantic search over the user's ingested corpus (ADR-0091 D8).
 * The model gets each hit minus `record`, which is lookup plumbing, not evidence.
 * Put a new lookup fact inside `record` so this strip drops it.
 */
export const corpusTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "system",
    action: "corpus_search",
    riskTier: "no_risk",
    staging: "fast_path",
    // Lazy, not kernel: the kernel prompt budget is tight.
    description:
      "Search the user's personal document corpus — everything Alfred has ingested: emails, email attachments (PDFs included), GitHub and Sentry activity, and connected-source documents. Activity hits carry the provider in `source`, the receipt `kind`, and a `url` when the provider supplied a link; use that URL when citing the event. Use this for questions such as what happened in Sentry this week or what changed on my pull requests yesterday. Returns ranked passages with their source, title, date, and, for PDFs, the exact page number the passage sits on (cite it as 'page N'; non-PDF hits carry no page and you must not invent one). Attachment hits may also carry `occurrences`: every email that carried byte-identical content of that file (filename, mimeType, threadId), so a hit titled by one carrier can be matched to another name the user mentions. Use this for anything that lives in the user's own records — 'what does my resume say about X', 'find the contract clause about termination', 'which email mentioned the invoice number'. For live public information use web_search instead; to open a specific known URL use fetch_url.",
    inputSchema: corpusSearchInput,
    execute: async (input, ctx) => {
      const hits = await ctx.corpus.search({ query: input.query, userId: ctx.userId });

      const modelHits: ModelFacingHit[] = hits.map((hit) => {
        const { record: _record, ...rest } = hit;

        return rest;
      });

      return { ok: true, query: input.query, hits: modelHits };
    },
  }),
];
