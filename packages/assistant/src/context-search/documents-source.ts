import {
  EVIDENCE_CITATION_LABEL_MAX_CHARS,
  EVIDENCE_CITATION_URL_MAX_CHARS,
  integrationDisplayName,
  sanitizeErrorMessage,
  type ContextSearchRequest,
  type EvidenceCard,
} from "@alfred/contracts";
import { search, type SearchHit } from "@alfred/corpus";
import type { ContextSource, ContextSourceResult } from "./registry";
import { compareByScoreThenId, internalSourceRef, renderContent } from "./vector-source";

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
 * Cards are re-sorted by score here so the adapter's order is deterministic
 * even if the primitive changes its own ordering; that ordering and the
 * content fallback are shared with the memory adapter in `vector-source.ts`.
 * Cross-source ranking is #427, not this file.
 */

/** Stable manifest id for the ingested-document corpus adapter (#466). */
const DOCUMENT_CONTEXT_SOURCE_ID = "documents";

/** Build the document context source over the real `@alfred/corpus` verb. */
export function createDocumentContextSource(): ContextSource {
  return {
    id: DOCUMENT_CONTEXT_SOURCE_ID,
    async search(request: ContextSearchRequest): Promise<ContextSourceResult> {
      const hits = await search({
        query: request.query,
        userId: request.userId,
        limit: request.limit,
      });

      const evidence = [...hits].sort(compareByScoreThenId).map(documentHitToEvidenceCard);

      return { evidence };
    },
  };
}

/**
 * Map one corpus hit to a canonical card. The id is the chunk id — the same
 * chunk retrieved twice is the same card — and the expansion handle points at
 * the parent document, the unit a later live drill-down (#428) fetches.
 */
function documentHitToEvidenceCard(hit: SearchHit): EvidenceCard {
  // `sanitizeErrorMessage` bounds and strips poison; an all-poison title
  // collapses to empty, which is not a citation, so it falls back to undefined.
  // The label cap is the tighter bound shared with the citation schema.
  const title = hit.title
    ? sanitizeErrorMessage(hit.title, EVIDENCE_CITATION_LABEL_MAX_CHARS) || undefined
    : undefined;

  return {
    id: `${DOCUMENT_CONTEXT_SOURCE_ID}:${hit.chunkId}`,
    source: internalSourceRef(DOCUMENT_CONTEXT_SOURCE_ID, "Documents"),
    mediaKind: "document",
    ...renderContent(hit.preview, "No extracted text is available for this chunk."),
    score: hit.similarity,
    time: {
      // `authoredAt` is the authored instant (an email Date header, an event
      // start), so it is when the underlying event happened — `occurredAt`,
      // never `observedAt`, which is when the source observed the record.
      ...(hit.authoredAt ? { occurredAt: hit.authoredAt.toISOString() } : {}),
      freshness: "ingested",
    },
    citations: [
      {
        // A title is the useful citation; without one, name the provider the
        // hit came from rather than humanizing the raw slug (`github` would
        // become "Github"). `integrationDisplayName` reads the display registry
        // and falls back to `humanizeSlug` for a non-integration source.
        label: title ?? integrationDisplayName(hit.source),
        ...(hit.url && hit.url.length <= EVIDENCE_CITATION_URL_MAX_CHARS ? { url: hit.url } : {}),
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
