import {
  EVIDENCE_CITATION_LABEL_MAX_CHARS,
  EVIDENCE_CITATION_URL_MAX_CHARS,
  integrationDisplayName,
  sanitizeErrorMessage,
  sourceAuthorityFromManifest,
  sourceRefFromManifest,
  type ContextSearchRequest,
  type EvidenceCard,
  type RetrievalSourceManifest,
  type SourceManifest,
} from "@alfred/contracts";
import { search, toModelFacingHit, type ModelFacingHit } from "@alfred/corpus";
import { defineContextSource, type ContextSource } from "./registry";
import { compareByScoreThenId, renderContent } from "./vector-source";

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
 * Cross-source ranking is `rank.ts` (#427), not this file.
 */

/**
 * What this source declares (#466): `high` authority because a chunk is a
 * VERBATIM slice of the provider's own record — an email body, an attachment's
 * text — not a summary of one. It names no `integration` and no `domains`
 * because it spans every ingested provider at once; the per-record provider
 * rides each card's citation instead. The cost is `metered`: the corpus search
 * embeds the query, so one read is one embedding call. Only the fields the
 * boundary acts on are declared; catalog-reserved fields stay unset.
 *
 * The manifest is the single owner of the kind, display name, source ref,
 * and authority: cards derive all of them from it, so the declaration and the
 * evidence cannot drift. The stable id lives once in
 * `DOCUMENT_CONTEXT_SOURCE_ID` and the registry mints it into the manifest.
 */
const DOCUMENT_CONTEXT_SOURCE_ID = "documents";

const DOCUMENT_CONTEXT_SOURCE_MANIFEST_BASE: Omit<RetrievalSourceManifest, "id" | "read"> = {
  kind: "internal",
  displayName: "Documents",
  freshness: { typical: "ingested" },
  authority: { level: "high", label: "verbatim slice of an ingested provider record" },
  cost: { class: "metered" },
  availability: "available",
};

/**
 * The manifest as cards read it: the base plus the once-stated id. Cards
 * derive their source ref and authority from this rather than restating
 * either beside the manifest fragment.
 */
function documentManifest(): SourceManifest {
  return { ...DOCUMENT_CONTEXT_SOURCE_MANIFEST_BASE, id: DOCUMENT_CONTEXT_SOURCE_ID };
}

/**
 * Tolerance for a sender-controlled authored instant that lies slightly in the
 * future. The ranker (#427) reads an instant up to one day past `now` as
 * current clock skew and drops anything beyond it; the adapter applies the same
 * bound so a `Date: Sat, 1 Jan 3000` header never reaches the model as
 * `occurred <future>` nor earns maximum recency.
 */
const DOCUMENT_FUTURE_SKEW_MS = 86_400_000;

/** Build the document context source over the real `@alfred/corpus` verb. */
export function createDocumentContextSource(): ContextSource {
  return defineContextSource({
    id: DOCUMENT_CONTEXT_SOURCE_ID,
    manifest: DOCUMENT_CONTEXT_SOURCE_MANIFEST_BASE,
    reads: { semantic_search: readDocuments },
  });
}

async function readDocuments(request: ContextSearchRequest) {
  const hits = await search({
    query: request.query,
    userId: request.userId,
    limit: request.limit,
  });

  // Cards are model-facing: strip the corpus `record` before mapping so the
  // mapper below cannot see dereference plumbing and the handle it mints
  // stays inside Alfred's own store (an Alfred document id, like
  // `memory_chunk` → chunk id and `integration_object` → object id).
  const evidence = [...hits]
    .map(toModelFacingHit)
    .sort(compareByScoreThenId)
    .map(documentHitToEvidenceCard);

  return { evidence };
}

/**
 * Map one model-facing corpus hit to a canonical card. The id is the chunk
 * id — the same chunk retrieved twice is the same card — and the expansion
 * handle points at the parent document, the unit a later live drill-down
 * (#428) fetches.
 *
 * The parameter is deliberately `ModelFacingHit`, not `SearchHit`: the
 * corpus `record` (provider id, account, thread in `@alfred/corpus`, #1076)
 * is for the future expander, and this mapper must not see it. A provider
 * address must ride the canonical `(provider, kind, externalId)`
 * `objectIdentitySchema` in `@alfred/contracts` — the shape the request
 * envelope, the evidence card `object`, and the object-state store read
 * already derive from — never a fused `gmail_message` kind beside it, and a
 * handle's `sourceId` must name the `ContextSource` that can actually expand
 * its `ref` (S1/S2 on #1076). `documents` declares only `semantic_search`
 * today, and its `ref` stays inside its own store until #428 declares
 * `expand` plus the `objectKinds` it can dereference.
 */
function documentHitToEvidenceCard(hit: ModelFacingHit): EvidenceCard {
  // `sanitizeErrorMessage` bounds and strips poison; an all-poison title
  // collapses to empty, which is not a citation, so it falls back to undefined.
  // The label cap is the tighter bound shared with the citation schema.
  const title = hit.title
    ? sanitizeErrorMessage(hit.title, EVIDENCE_CITATION_LABEL_MAX_CHARS) || undefined
    : undefined;

  const authority = sourceAuthorityFromManifest(documentManifest());

  return {
    id: `${DOCUMENT_CONTEXT_SOURCE_ID}:${hit.chunkId}`,
    source: sourceRefFromManifest(documentManifest()),
    mediaKind: "document",
    ...renderContent(hit.preview, "No extracted text is available for this chunk."),
    score: hit.similarity,
    ...(authority !== undefined ? { authority } : {}),
    time: {
      // `authoredAt` is the authored instant (an email Date header, an event
      // start), so it is when the underlying event happened — `occurredAt`,
      // never `observedAt`, which is when the source observed the record.
      // Sender-controlled and therefore untrusted for range: a future instant
      // beyond clock-skew tolerance is omitted rather than rendered or ranked
      // as maximally recent.
      ...(isUsableAuthoredAt(hit.authoredAt) ? { occurredAt: hit.authoredAt.toISOString() } : {}),
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

function isUsableAuthoredAt(value: Date | null): value is Date {
  if (value === null) return false;

  const at = value.getTime();

  if (!Number.isFinite(at)) return false;

  return at <= Date.now() + DOCUMENT_FUTURE_SKEW_MS;
}
