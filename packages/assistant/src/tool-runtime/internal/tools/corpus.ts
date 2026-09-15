import { corpusSearchInput } from "@alfred/contracts";
import type { ModelFacingHit } from "@alfred/corpus";
import type { RegisteredTool } from "@alfred/assistant/tool-runtime";
import { liveTool } from "@alfred/assistant/tool-runtime";

/**
 * `system.corpus_search` — read-only semantic search over the user's ingested
 * document corpus (ADR-0091 D8). The corpus dependency rides the execute
 * context (`ctx.corpus.search`, built in `../../context`), so this module
 * never imports `@alfred/db` or `@alfred/corpus` and the tool graph stays free
 * of the static database edge.
 *
 * The hit reaches the model as a `ModelFacingHit` (#1076): the retrieval
 * shape minus its `record`. The record identity — the provider's own id, the
 * carrying account, the thread — is dereference plumbing for the evidence-card
 * expansion handle a live drill-down (#428) reads, not evidence. The
 * per-carrier `occurrences` the description promises stay: they are the
 * deliberately disclosed provenance, one message, thread, and account per
 * carrier, while `record` names the row's own (possibly folded) identity.
 * The description names the selection-relevant fields, not the full row —
 * chunk/document ids, position, preview, and similarity ride along as the
 * ranked-passage payload.
 * A new dereference fact belongs inside `record`, where the strip below
 * excludes it by construction; the strip names exactly one key, so there is
 * no per-field list to drift. The destructure is inline (not the corpus
 * converter) so this module keeps its type-only corpus edge.
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

      const modelHits: ModelFacingHit[] = hits.map((hit) => {
        const { record: _record, ...rest } = hit;

        return rest;
      });

      return { ok: true, query: input.query, hits: modelHits };
    },
  }),
];
