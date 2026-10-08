import {
  EVIDENCE_CITATION_LABEL_MAX_CHARS,
  EVIDENCE_CITATION_URL_MAX_CHARS,
  integrationDisplayName,
  isFileDocumentSource,
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
import { logger } from "@alfred/logging";
import { boundCardText, cardNamesObjectRef } from "./object-ref";
import { defineContextSource, type ContextSource } from "./registry";
import { compareByScoreThenId, renderContent } from "./vector-source";

/**
 * Ingested-document source (#424, ADR-0101): maps corpus `search` hits to cards.
 * No retrieval logic of its own. One source for every ingested provider; the
 * provider rides the citation label.
 *
 * Annotation (#1087, ADR-0062): when a chunk's own text names exactly one work
 * object, the card carries that object's state with `relation: "names"`.
 * Text only proposes keys; only the projection says the state.
 */

/**
 * `high` authority: a chunk is a verbatim slice of the record. `metered`: each
 * read embeds the query. No `integration`, because it spans every provider.
 */
const DOCUMENT_CONTEXT_SOURCE_ID = "documents";

const DOCUMENT_CONTEXT_SOURCE_MANIFEST_BASE: Omit<RetrievalSourceManifest, "id" | "read"> = {
  kind: "internal",
  displayName: "Documents",
  freshness: { typical: "ingested" },
  authority: { level: "high", label: "verbatim slice of an ingested provider record" },
  cost: { class: "metered" },
  availability: "available",
  // Exactly what `documentMediaKind` mints (#429). The corpus holds no images:
  // a `needs_ocr` PDF never becomes a row.
  mediaKinds: ["text", "document"],
};

function documentManifest(): SourceManifest {
  return { ...DOCUMENT_CONTEXT_SOURCE_MANIFEST_BASE, id: DOCUMENT_CONTEXT_SOURCE_ID };
}

/** Same one-day skew bound as the ranker. A sender's `Date` header can claim year 3000. */
const DOCUMENT_FUTURE_SKEW_MS = 86_400_000;

export function createDocumentContextSource(): ContextSource {
  return defineContextSource({
    id: DOCUMENT_CONTEXT_SOURCE_ID,
    manifest: DOCUMENT_CONTEXT_SOURCE_MANIFEST_BASE,
    reads: { semantic_search: readDocuments },
  });
}

async function readDocuments(request: ContextSearchRequest, signal: AbortSignal) {
  const hits = await search({
    query: request.query,
    userId: request.userId,
    limit: request.limit,
  });

  // Strip the corpus `record`, so no provider plumbing reaches a card.
  const modelFacing = [...hits].map(toModelFacingHit).sort(compareByScoreThenId);
  const objects = await namedObjectByCardId(request.userId, modelFacing, signal);

  const evidence = modelFacing.map((hit) =>
    documentHitToEvidenceCard(hit, objects.get(documentCardId(hit))),
  );

  return { evidence };
}

/** The same chunk retrieved twice is one card. */
function documentCardId(hit: ModelFacingHit): string {
  return `${DOCUMENT_CONTEXT_SOURCE_ID}:${hit.chunkId}`;
}

/**
 * The one work object each hit's rendered title and preview names (#1087).
 * Two different objects is ambiguous, so no annotation. A throw in propose or
 * resolve degrades to no annotation, not to a failed source. Log the raw
 * `err`: pino's serializer drops a pre-rendered string.
 */
async function namedObjectByCardId(
  userId: string,
  hits: readonly ModelFacingHit[],
  signal: AbortSignal,
): Promise<ReadonlyMap<string, EvidenceObjectRef>> {
  const found = new Map<string, EvidenceObjectRef>();

  try {
    const subjects: ReconcileCandidates<"annotates">[] = [];

    for (const hit of hits) {
      const id = documentCardId(hit);
      const subject = { id, text: { subject: hit.title ?? "", content: hit.preview } };
      const keys = proposeObjectKeys(subject, { reading: "annotates" });

      if (keys.length > 0) subjects.push({ id, keys });
    }

    if (subjects.length === 0) return found;

    const reconciled = await reconcileEvidence({ userId, subjects, abortSignal: signal });

    for (const [id, resolved] of reconciled) {
      const byObjectId = new Map(resolved.map((object) => [object.state.objectId, object]));

      if (byObjectId.size !== 1) continue;
      const [object] = [...byObjectId.values()];

      if (!object) continue;
      // The chunk names the object; it is not the object. Never use
      // `cardIsObjectRef` here: it compiles, and it would turn on `exactMatch`.
      const ref = cardNamesObjectRef(object);

      if (ref) found.set(id, ref);
    }
  } catch (err) {
    // An abort belongs to the collect timeout. Do not log it as a failure.
    if (signal.aborted) throw err;
    logger.error(
      { err, event: "context_search_object_annotation_failed", userId },
      "Resolving named object state for document cards failed; cards are unannotated",
    );

    return new Map();
  }

  return found;
}

/**
 * One hit as a card. The handle points at the parent document.
 * Takes `ModelFacingHit`, not `SearchHit`, so it cannot see the corpus `record`.
 * Pure: `object` is resolved once per page in `readDocuments`.
 */
function documentHitToEvidenceCard(hit: ModelFacingHit, object?: EvidenceObjectRef): EvidenceCard {
  // An all-poison title collapses to empty, so it becomes undefined.
  const title = boundCardText(hit.title, EVIDENCE_CITATION_LABEL_MAX_CHARS);

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
      // Authored instant, so `occurredAt`. Sender-controlled: drop a far-future value.
      ...(isUsableAuthoredAt(hit.authoredAt) ? { occurredAt: hit.authoredAt.toISOString() } : {}),
      freshness: "ingested",
    },
    citations: [
      {
        // No title: name the provider, not the humanized slug ("Github").
        label: title ?? integrationDisplayName(hit.source),
        ...(hit.url && hit.url.length <= EVIDENCE_CITATION_URL_MAX_CHARS ? { url: hit.url } : {}),
      },
    ],
    // The page goes in the anchor only, not in a citation locator (#429).
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
 * File rows and paged hits are `document`; message bodies and receipts are
 * `text` (#429). The corpus row has no MIME type to read.
 */
function documentMediaKind(hit: ModelFacingHit): EvidenceMediaKind {
  if (hit.page !== null) return "document";

  return isFileDocumentSource(hit.source) ? "document" : "text";
}

/**
 * At most one: a chunk never spans two pages. No `confidence`, because the page
 * is proven. Mutable, because the schema-derived card field is mutable.
 */
function pageAnchors(page: number | null): EvidenceAnchor[] {
  return page === null ? [] : [{ kind: "page", page }];
}
