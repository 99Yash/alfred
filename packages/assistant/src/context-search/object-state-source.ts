import {
  EVIDENCE_CITATION_LABEL_MAX_CHARS,
  EVIDENCE_CITATION_URL_MAX_CHARS,
  EVIDENCE_SNIPPET_MAX_CHARS,
  integrationDisplayName,
  isObjectStateProvider,
  sanitizeErrorMessage,
  sourceAuthorityFromManifest,
  sourceRefFromManifest,
  type ContextObjectRef,
  type ContextSearchRequest,
  type EvidenceCard,
  type EvidenceCitation,
  type EvidenceObjectRef,
  type RetrievalSourceManifest,
} from "@alfred/contracts";
import {
  objectStateStore,
  type ObjectState,
  type ObjectStateStore,
} from "@alfred/assistant/connections";
import { sha256Canonical } from "@alfred/db/hash";
import type { ContextSource, ContextSourceResult } from "./registry";

/**
 * The deterministic object-state adapter (#425; epic #422; ADR-0101).
 *
 * It is the only source that reads the request's exact `objects` references
 * instead of the free-text `query`. Object state is a projection of provider
 * webhooks (`integration_objects` / `_keys`); there is no embedding to search,
 * so a lookup is a provider-declared key → object row, or a provider-native
 * identity → object row. Pulling a `head_sha` out of prose would be the fuzzy
 * retrieval this slice exists to avoid, so the adapter never parses the query:
 * no references means no evidence.
 *
 * Honesty is structural. A key that resolves to nothing, a reference that
 * resolves to a row that is gone, a provider this build does not project, and a
 * stored identity whose text cannot be represented all produce a card that says
 * so and carries no `object` and no `stateCategory`. Absence is never read as
 * `active`, and — the ADR-0048-D contract — absence never closes a loop.
 *
 * The store is the read path the briefing reconciliation already uses; this
 * adapter adds no write and no new state authority, and the injected reader
 * exists so the mapping can be exercised against a fake without a database.
 */

/**
 * What this source declares (#466).
 *
 * `read: ["exact_lookup"]` is the load-bearing declaration. This adapter never
 * reads the free-text query, so the boundary must not spend a lookup on it for
 * a question that carries no object references — and with the manifest it no
 * longer does. Its authority is `high`: the state is a deterministic reduction
 * of provider webhook deliveries, not an inference. The manifest declares only
 * what the boundary acts on; the wider catalog surface (`objectKinds`,
 * `identityKeys`, `indexability`, `discovery`, latency hints) stays unset.
 *
 * The manifest is the single owner of the id, kind, display name, source ref,
 * and authority: cards derive all of them from it, so the declaration and the
 * evidence cannot drift.
 */
const OBJECT_STATE_CONTEXT_SOURCE_MANIFEST: RetrievalSourceManifest = {
  id: "object-state",
  kind: "internal",
  displayName: "Object state",
  read: ["exact_lookup"],
  freshness: { typical: "ingested" },
  authority: { level: "high", label: "deterministic projection of provider webhook deliveries" },
  cost: { class: "local" },
  availability: "available",
};

/**
 * The read surface this adapter needs. Narrower than `ObjectStateStore` so the
 * adapter cannot write and a test does not have to fake the whole store.
 */
export type ObjectStateReader = Pick<
  ObjectStateStore,
  "resolveByKey" | "getState" | "getByIdentity"
>;

/** Build the object-state context source over the real store. */
export function createObjectStateContextSource(
  store: ObjectStateReader = objectStateStore,
): ContextSource {
  return {
    id: OBJECT_STATE_CONTEXT_SOURCE_MANIFEST.id,
    manifest: OBJECT_STATE_CONTEXT_SOURCE_MANIFEST,
    async search(request: ContextSearchRequest): Promise<ContextSourceResult> {
      const refs = request.objects;

      if (refs === undefined || refs.length === 0) return { evidence: [] };

      // Resolve every requested reference, not `refs.slice(0, request.limit)`:
      // `limit` is the *combined evidence* budget that `searchContext` owns and
      // counts, not this source's reference cap. Slicing here would silently
      // drop references past the budget, so the caller would see a clean `ok`
      // with no miss card and no omission count even though the lookups never
      // happened. Emitting one card per reference keeps the miss honest; the
      // boundary truncates and reports the overflow.
      const evidence = await Promise.all(
        refs.map((ref) => resolveObjectRef(store, request.userId, ref)),
      );

      return { evidence };
    },
  };
}

/**
 * Resolve one caller-supplied reference to a card. A key reference is a
 * two-step resolve (key index → object row); an identity reference is the
 * object row directly. Both paths can miss, and a miss is a card, not a dropped
 * element: the caller learns the lookup happened and found nothing.
 */
async function resolveObjectRef(
  store: ObjectStateReader,
  userId: string,
  ref: ContextObjectRef,
): Promise<EvidenceCard> {
  if (!isObjectStateProvider(ref.provider)) {
    return missingRefCard(
      ref,
      `No object-state provider "${integrationDisplayName(ref.provider)}" is known to this build.`,
    );
  }

  if (ref.by === "key") {
    const resolved = await store.resolveByKey(userId, ref.provider, ref.keyKind, ref.keyValue);

    if (!resolved) {
      return missingRefCard(
        ref,
        `No ${integrationDisplayName(ref.provider)} object resolves this ${ref.keyKind} key.`,
      );
    }

    const state = await store.getState(userId, resolved);

    if (!state) {
      return missingRefCard(
        ref,
        `The ${integrationDisplayName(ref.provider)} object for this key is no longer stored.`,
      );
    }

    return objectStateCard(state);
  }

  const state = await store.getByIdentity(userId, ref);

  if (!state) {
    return missingRefCard(
      ref,
      `No stored ${integrationDisplayName(ref.provider)} ${ref.kind} matches this identity.`,
    );
  }

  return objectStateCard(state);
}

/**
 * A resolved object. The identity, native state, agnostic category, title, URL,
 * repo, and the delivery instant all ride the card; `score` is the exact-match
 * confidence `1` (this is a deterministic hit, not a similarity).
 */
function objectStateCard(state: ObjectState): EvidenceCard {
  const kind = bound(state.kind, 100);
  const externalId = bound(state.externalId, 512);

  if (!kind || !externalId) {
    // A stored row whose identity text sanitizes to nothing cannot be cited.
    // Degrade rather than mint a card with an empty identity.
    return missingObjectCard(
      state.objectId,
      "The stored object identity could not be read; state is unavailable.",
    );
  }

  const nativeState = bound(state.nativeState, 200);
  const title = bound(state.title, 500);
  const repo = bound(state.repo, 300);

  // A URL longer than the citation cap is not cited rather than truncated into a
  // link that no longer resolves (the document adapter's rule). It still goes
  // through `bound` so NUL/surrogate poison cannot ride the raw field into the
  // card, the one field that previously skipped the strip.
  const url =
    state.url !== null && state.url.length <= EVIDENCE_CITATION_URL_MAX_CHARS
      ? bound(state.url, EVIDENCE_CITATION_URL_MAX_CHARS)
      : undefined;

  const object: EvidenceObjectRef = {
    provider: state.provider,
    kind,
    externalId,
    stateCategory: state.stateCategory,
    ...(nativeState ? { nativeState } : {}),
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
    ...(repo ? { repo } : {}),
  };

  const citation: EvidenceCitation = {
    label:
      bound(title, EVIDENCE_CITATION_LABEL_MAX_CHARS) ??
      `${integrationDisplayName(state.provider)} ${kind}`,
    ...(url ? { url } : {}),
    locator: bound(repo ?? `${kind} ${externalId}`, 500) ?? state.objectId,
  };

  const authority = sourceAuthorityFromManifest(OBJECT_STATE_CONTEXT_SOURCE_MANIFEST);

  return {
    id: `${OBJECT_STATE_CONTEXT_SOURCE_MANIFEST.id}:${state.objectId}`,
    source: sourceRefFromManifest(OBJECT_STATE_CONTEXT_SOURCE_MANIFEST),
    mediaKind: "text",
    snippet: objectStateSnippet(state, title, nativeState, repo),
    score: 1,
    object,
    ...(authority !== undefined ? { authority } : {}),
    // The projection observed the state when the last advancing delivery
    // arrived; without that instant the freshness is honestly unknown.
    time: state.stateDeliveredAt
      ? { observedAt: state.stateDeliveredAt.toISOString(), freshness: "ingested" }
      : { freshness: "unknown" },
    citations: [citation],
    expansion: {
      sourceId: OBJECT_STATE_CONTEXT_SOURCE_MANIFEST.id,
      kind: "integration_object",
      ref: state.objectId,
      ...(title ? { hint: bound(title, 300) } : {}),
    },
  };
}

/**
 * A reference that did not resolve to readable state. It carries a `note` and
 * deliberately no `object` / `stateCategory`: the adapter never invents a
 * lifecycle bucket from a missing row. `score: 0` lets the ranker demote it.
 */
function missingRefCard(ref: ContextObjectRef, note: string): EvidenceCard {
  // Distinct refs must not collapse to one id. A key ref concatenates up to
  // ~830 characters, so the 512-character id cap would truncate two different
  // references into the same card; a canonical hash of the full reference keeps
  // the id stable and unique instead.
  const identity =
    ref.by === "key"
      ? { by: ref.by, provider: ref.provider, keyKind: ref.keyKind, keyValue: ref.keyValue }
      : { by: ref.by, provider: ref.provider, kind: ref.kind, externalId: ref.externalId };

  return missingCard(
    `${OBJECT_STATE_CONTEXT_SOURCE_MANIFEST.id}:missing:${sha256Canonical(identity)}`,
    note,
  );
}

function missingObjectCard(objectId: string, note: string): EvidenceCard {
  return missingCard(`${OBJECT_STATE_CONTEXT_SOURCE_MANIFEST.id}:${objectId}`, note);
}

function missingCard(id: string, note: string): EvidenceCard {
  const authority = sourceAuthorityFromManifest(OBJECT_STATE_CONTEXT_SOURCE_MANIFEST);

  return {
    // Callers either pass an object id or a fixed-length hash; `bound` is the
    // defensive strip/truncate for an unexpectedly long value, not the identity
    // guarantee (the hash is what keeps distinct refs distinct).
    id: bound(id, 512) ?? `${OBJECT_STATE_CONTEXT_SOURCE_MANIFEST.id}:unresolved`,
    source: sourceRefFromManifest(OBJECT_STATE_CONTEXT_SOURCE_MANIFEST),
    mediaKind: "text",
    score: 0,
    ...(authority !== undefined ? { authority } : {}),
    note: bound(note, 1_000) ?? "Object state is unavailable.",
    time: { freshness: "unknown" },
  };
}

/** A short, deterministic reading of the object for the model-facing snippet. */
function objectStateSnippet(
  state: ObjectState,
  title: string | undefined,
  nativeState: string | undefined,
  repo: string | undefined,
): string {
  const label = title ?? `${state.kind} ${state.externalId}`;
  const where = repo ? ` (${repo})` : "";
  const reading = nativeState ?? "state unknown";

  return bound(`${label}${where}: ${reading}`, EVIDENCE_SNIPPET_MAX_CHARS) ?? "Object state";
}

/**
 * Bound and strip poison from one provider string, collapsing an empty result
 * to `undefined` so it is omitted rather than emitted as `""`.
 */
function bound(value: string | null | undefined, maxChars: number): string | undefined {
  if (value === null || value === undefined) return undefined;

  return sanitizeErrorMessage(value, maxChars) || undefined;
}
