import {
  EVIDENCE_CITATION_LABEL_MAX_CHARS,
  EVIDENCE_CITATION_URL_MAX_CHARS,
  integrationDisplayName,
  isFileDocumentSource,
  sanitizeErrorMessage,
  sourceAuthorityFromManifest,
  sourceRefFromManifest,
  type BuiltInExpansionKind,
  type ContextSearchRequest,
  type EvidenceAnchor,
  type EvidenceCard,
  type EvidenceMediaKind,
  type EvidenceObjectRef,
  type RetrievalSourceManifest,
  type SourceManifest,
} from "@alfred/contracts";
import {
  proposeObjectKeys,
  reconcileEvidence,
  type ReconcileCandidates,
} from "@alfred/assistant/connections";
import { search, toModelFacingHit, type ModelFacingHit } from "@alfred/corpus";
import { logger, safeErrorDiagnostic } from "@alfred/logging";
import { evidenceObjectRefFromState } from "./object-ref";
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
 *
 * One annotation rides on top of the translation (#1087): a chunk whose own
 * rendered text names a work object carries that object's reducer-owned state.
 * It obeys ADR-0062's propose / dispose contract. The text may only PROPOSE a
 * candidate key; only the projection may say what the work's state is. So the
 * card never reads a lifecycle out of prose, an unresolvable or ambiguous
 * reference leaves the card exactly as it was, and the object declares
 * `relation: "mentions"` — the chunk was still reached by similarity, and the
 * ranker must not read the annotation as an exact-key retrieval.
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
  // Exactly the two modalities `documentMediaKind` can mint, and the boundary
  // holds every card to this list (#429). The corpus ingests a message body
  // (`text`) and a file (`document`). A hit whose page structure the extractor
  // proved (ADR-0091) stays a `document`: the page is granularity, so it rides
  // the `page` anchor rather than taking the modality slot. The corpus ingests
  // no picture and no recording: a `needs_ocr` PDF never becomes a row at all,
  // so declaring `image` here would name a card this source cannot produce.
  mediaKinds: ["text", "document"],
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
  const modelFacing = [...hits].map(toModelFacingHit).sort(compareByScoreThenId);
  const objects = await mentionedObjectByCardId(request.userId, modelFacing);

  const evidence = modelFacing.map((hit) =>
    documentHitToEvidenceCard(hit, objects.get(documentCardId(hit))),
  );

  return { evidence };
}

/** The stable card id for one hit: the same chunk retrieved twice is one card. */
function documentCardId(hit: ModelFacingHit): string {
  return `${DOCUMENT_CONTEXT_SOURCE_ID}:${hit.chunkId}`;
}

/**
 * The work object each hit's own text names, for the hits where exactly one
 * resolves (#1087).
 *
 * The text read is the text the card RENDERS — its title and its bounded
 * preview — and nothing wider: the annotation must be justified by what a
 * reader of the card can see. No corpus read is added.
 *
 * Two rules keep the annotation honest. `annotates` is the reading, so an
 * adapter proposes every key the chunk names and no caller drops or suppresses
 * anything on the result. And a hit is annotated only when its keys resolve to
 * ONE object: two written forms can name one row (a repository rename mints a
 * second `pull_request_url`), so the set is deduplicated by object id first,
 * and a chunk naming two different objects is an ambiguous reference that
 * leaves the card unchanged.
 *
 * A failed resolve degrades to no annotation. `reconcileEvidence` reads the
 * database, and an unguarded throw here would turn the whole `documents` source
 * into an error report and drop EVERY document card for this search — far worse
 * than losing an annotation. The catch logs, because a silent catch of exactly
 * this shape once hid a total briefing failure for seven weeks.
 */
async function mentionedObjectByCardId(
  userId: string,
  hits: readonly ModelFacingHit[],
): Promise<ReadonlyMap<string, EvidenceObjectRef>> {
  const found = new Map<string, EvidenceObjectRef>();
  const subjects: ReconcileCandidates[] = [];

  for (const hit of hits) {
    const id = documentCardId(hit);
    const subject = { id, text: { subject: hit.title ?? "", content: hit.preview } };
    const keys = proposeObjectKeys(subject, { reading: "annotates" });

    if (keys.length > 0) subjects.push({ id, keys });
  }

  if (subjects.length === 0) return found;

  try {
    const reconciled = await reconcileEvidence({ userId, subjects });

    for (const [id, resolved] of reconciled) {
      const byObjectId = new Map(resolved.map((object) => [object.state.objectId, object.state]));

      if (byObjectId.size !== 1) continue;
      const [state] = [...byObjectId.values()];

      if (!state) continue;
      // The chunk NAMES this object; it is not the object. The relation is what
      // keeps the ranker's exact-retrieval feature off a semantic hit.
      const ref = evidenceObjectRefFromState(state, "mentions");

      if (ref) found.set(id, ref);
    }
  } catch (err) {
    logger.error(
      { err: safeErrorDiagnostic(err), event: "context_search_object_annotation_failed", userId },
      "Resolving mentioned object state for document cards failed; cards are unannotated",
    );

    return new Map();
  }

  return found;
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
 *
 * `object` is the optional annotation described in the module docstring. It is
 * a parameter rather than a lookup so this mapper stays pure and reads no
 * store: the one resolve runs once for the whole page in `readDocuments`.
 */
function documentHitToEvidenceCard(hit: ModelFacingHit, object?: EvidenceObjectRef): EvidenceCard {
  // `sanitizeErrorMessage` bounds and strips poison; an all-poison title
  // collapses to empty, which is not a citation, so it falls back to undefined.
  // The label cap is the tighter bound shared with the citation schema.
  const title = hit.title
    ? sanitizeErrorMessage(hit.title, EVIDENCE_CITATION_LABEL_MAX_CHARS) || undefined
    : undefined;

  const authority = sourceAuthorityFromManifest(documentManifest());
  const anchors = pageAnchors(hit.page);

  return {
    id: documentCardId(hit),
    source: sourceRefFromManifest(documentManifest()),
    mediaKind: documentMediaKind(hit),
    ...renderContent(hit.preview, "No extracted text is available for this chunk."),
    score: hit.similarity,
    ...(object ? { object } : {}),
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
      },
    ],
    // The page rides the ANCHOR, not a citation locator string (#429). It used
    // to be prose (`page 3`), which a consumer could only read by parsing the
    // label it was joined to; the anchor is the structured carrier the contract
    // minted for it, and the packer renders it on its own line. Stating it in
    // both places would put one fact under two spellings.
    ...(anchors.length > 0 ? { anchors } : {}),
    expansion: {
      sourceId: DOCUMENT_CONTEXT_SOURCE_ID,
      kind: "document" satisfies BuiltInExpansionKind,
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

/**
 * The modality of one corpus hit (#429).
 *
 * Two readings, in the order of what each one PROVES:
 *
 * 1. A file row is a `document`, whether or not its page structure was proven.
 *    `chunks.metadata.page` is written only from page structure the extractor
 *    emitted (ADR-0091), and the chunker bounds a chunk to one page, so a hit
 *    that carries one is one page of a document — but the page is granularity,
 *    so it rides the `page` anchor while the modality stays `document`. A file
 *    row without a proven page is the same modality: a document whose pages
 *    were never proven (a text attachment, a PDF that extracted as text
 *    without offsets).
 * 2. Everything else is a message body or a webhook receipt: `text`.
 *
 * It never reads a MIME type, because the corpus row does not carry one — the
 * ingest lane already turned the bytes into text, and the modality of the
 * evidence is the modality of that text, not of the file it came from.
 */
function documentMediaKind(hit: ModelFacingHit): EvidenceMediaKind {
  if (hit.page !== null) return "document";

  return isFileDocumentSource(hit.source) ? "document" : "text";
}

/**
 * The page anchor for one hit, or none.
 *
 * A list of at most one: the chunker never lets a chunk span two pages, so one
 * hit anchors to one page. It carries no `confidence`, because the page is
 * proven rather than estimated — a confidence would invite a reader to discount
 * a fact the extractor established. The card schema bounds `page` to a positive
 * integer and `extractPageFromMetadata` already rejected anything else, so the
 * two gates agree.
 *
 * The list is mutable because `EvidenceCard` derives from the Zod schema and
 * `z.array` infers a mutable array; a `readonly` return would not assign into
 * the field it exists to fill.
 */
function pageAnchors(page: number | null): EvidenceAnchor[] {
  return page === null ? [] : [{ kind: "page", page }];
}
