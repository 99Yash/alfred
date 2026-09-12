import {
  humanizeSlug,
  sanitizeErrorMessage,
  type ContextSearchRequest,
  type EvidenceCard,
} from "@alfred/contracts";
import { search, type SearchArgs, type SearchHit } from "@alfred/corpus";
import type { ContextSource, ContextSourceResult } from "./registry";

/**
 * The ingested-document adapter (#424; epic #422; ADR-0101).
 *
 * It is a thin, read-only translation of the corpus vector search
 * (`search` in `@alfred/corpus`, over `chunks ⨝ documents`) into canonical
 * `EvidenceCard`s. It owns no retrieval logic of its own: `search` embeds the
 * query, reranks by cosine distance, and bounds the pool; this file maps its
 * `SearchHit`s to cards and nothing more. That is the seam's point — the
 * fabric aggregates primitives rather than re-implementing pgvector.
 *
 * One adapter covers every ingested provider (`gmail`, `github`, …) because
 * the corpus table is already source-tagged and the search is source-agnostic.
 * The card's `source` is therefore the corpus itself (`documents`, `internal`),
 * the per-record provider rides the citation label, and the manifest (#466)
 * keys on the one stable id. Splitting per provider would clone this file once
 * per `DOCUMENT_SOURCES` member for no retrieval difference.
 *
 * The primitive is injected so a test can drive ranking and mapping without a
 * database; the default is the real verb. Cards are re-sorted by score here so
 * the adapter's order is deterministic even if a future primitive changes
 * `search`'s own ordering. Cross-source ranking is #427, not this file.
 */

/** Stable manifest id for the ingested-document corpus adapter (#466). */
const DOCUMENT_CONTEXT_SOURCE_ID = "documents";

/** Bound on a title carried into a citation label or expansion hint. */
const DOCUMENT_TITLE_MAX_CHARS = 300;

/** Citation URL ceiling, mirroring `evidenceCitationSchema`; longer URLs are dropped. */
const DOCUMENT_URL_MAX_CHARS = 2_048;

/** The retrieval verb this adapter wraps; injectable so tests need no DB. */
type DocumentSearch = (args: SearchArgs) => Promise<SearchHit[]>;

/**
 * Build the document context source. `runSearch` defaults to the real
 * `@alfred/corpus` verb; a test passes a fake that returns crafted hits.
 */
export function createDocumentContextSource(runSearch: DocumentSearch = search): ContextSource {
  return {
    id: DOCUMENT_CONTEXT_SOURCE_ID,
    async search(request: ContextSearchRequest): Promise<ContextSourceResult> {
      const hits = await runSearch({
        query: request.query,
        userId: request.userId,
        limit: request.limit,
      });

      const evidence = [...hits].sort(compareDocumentHits).map(documentHitToEvidenceCard);

      return { evidence };
    },
  };
}

/**
 * Deterministic source-local order: highest similarity first, chunk id as the
 * tie-break so an equal-score pair never flips between reads. #427 replaces
 * this with the cross-source ranker; until then it keeps the adapter stable.
 */
function compareDocumentHits(a: SearchHit, b: SearchHit): number {
  return b.similarity - a.similarity || a.chunkId.localeCompare(b.chunkId);
}

/**
 * Map one corpus hit to a canonical card. The id is the chunk id — the same
 * chunk retrieved twice is the same card — and the expansion handle points at
 * the parent document, the unit a later live drill-down (#428) fetches.
 */
export function documentHitToEvidenceCard(hit: SearchHit): EvidenceCard {
  // `sanitizeErrorMessage` bounds and strips poison; an all-poison title
  // collapses to empty, which is not a citation, so it falls back to undefined.
  const title = hit.title
    ? sanitizeErrorMessage(hit.title, DOCUMENT_TITLE_MAX_CHARS) || undefined
    : undefined;

  return {
    id: `${DOCUMENT_CONTEXT_SOURCE_ID}:${hit.chunkId}`,
    source: {
      id: DOCUMENT_CONTEXT_SOURCE_ID,
      kind: "internal",
      displayName: "Documents",
    },
    mediaKind: "document",
    ...renderSnippet(hit.preview),
    score: hit.similarity,
    time: {
      ...(hit.authoredAt ? { observedAt: hit.authoredAt.toISOString() } : {}),
      freshness: "ingested",
    },
    citations: [
      {
        // A title is the useful citation; without one, name the provider the
        // hit came from rather than citing the corpus adapter it arrived through.
        label: title ?? humanizeSlug(hit.source),
        ...(hit.url && hit.url.length <= DOCUMENT_URL_MAX_CHARS ? { url: hit.url } : {}),
        ...(hit.page !== null ? { locator: `page ${hit.page}` } : {}),
      },
    ],
    expansion: {
      sourceId: DOCUMENT_CONTEXT_SOURCE_ID,
      kind: "document",
      ref: hit.documentId,
      ...(title ? { hint: title } : {}),
    },
  };
}

/**
 * The card must carry content: snippet when the chunk has extracted text, an
 * honest note when it does not. An empty chunk is a real state (a media-only
 * attachment), never a reason to emit a contract-invalid card.
 */
function renderSnippet(preview: string): { snippet: string } | { note: string } {
  return preview.length > 0
    ? { snippet: preview }
    : { note: "No extracted text is available for this chunk." };
}
