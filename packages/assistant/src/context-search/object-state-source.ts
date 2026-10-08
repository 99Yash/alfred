import {
  EVIDENCE_CITATION_LABEL_MAX_CHARS,
  EVIDENCE_NOTE_MAX_CHARS,
  EVIDENCE_SNIPPET_MAX_CHARS,
  integrationDisplayName,
  isObjectStateProvider,
  sourceAuthorityFromManifest,
  sourceRefFromManifest,
  type BuiltInExpansionKind,
  type ContextObjectRef,
  type ContextSearchRequest,
  type EvidenceCard,
  type EvidenceCitation,
  type RetrievalSourceManifest,
  type SourceManifest,
} from "@alfred/contracts";
import {
  objectStateStore,
  type ObjectState,
  type ObjectStateStore,
} from "@alfred/assistant/connections";
import { sha256Canonical } from "@alfred/db/hash";
import { boundCardText, cardIsObjectRef } from "./object-ref";
import { defineContextSource, type ContextSource } from "./registry";

/**
 * Object-state source (#425, ADR-0101). Reads only the request's exact
 * `objects`, never the query text: no references, no evidence.
 * Every miss is a note card with no `object` or `stateCategory`, so absence is
 * never read as `active` and never closes a loop (ADR-0048 D).
 */

/** `high` authority: the state is a deterministic reduction of webhook deliveries. */
const OBJECT_STATE_CONTEXT_SOURCE_ID = "object-state";

const OBJECT_STATE_CONTEXT_SOURCE_MANIFEST_BASE: Omit<RetrievalSourceManifest, "id" | "read"> = {
  kind: "internal",
  displayName: "Object state",
  freshness: { typical: "ingested" },
  authority: { level: "high", label: "deterministic projection of provider webhook deliveries" },
  cost: { class: "local" },
  availability: "available",
  // A state row renders as text, and a degraded note card is text too (#429).
  mediaKinds: ["text"],
};

function objectStateManifest(): SourceManifest {
  return { ...OBJECT_STATE_CONTEXT_SOURCE_MANIFEST_BASE, id: OBJECT_STATE_CONTEXT_SOURCE_ID };
}

/** Read-only slice of the store, so the adapter cannot write and a test fakes less. */
export type ObjectStateReader = Pick<
  ObjectStateStore,
  "resolveByKey" | "getState" | "getByIdentity"
>;

export function createObjectStateContextSource(
  store: ObjectStateReader = objectStateStore,
): ContextSource {
  return defineContextSource({
    id: OBJECT_STATE_CONTEXT_SOURCE_ID,
    manifest: OBJECT_STATE_CONTEXT_SOURCE_MANIFEST_BASE,
    reads: {
      exact_lookup: async (request: ContextSearchRequest) => {
        const refs = request.objects;

        if (refs === undefined || refs.length === 0) return { evidence: [] };

        // Do not slice by `limit`: that is the boundary's combined budget, and a
        // slice would drop lookups with no miss card. The boundary truncates.
        const evidence = await Promise.all(
          refs.map((ref) => resolveObjectRef(store, request.userId, ref)),
        );

        return { evidence };
      },
    },
  });
}

/** Resolve one reference. A miss is a card, so the caller learns the lookup ran. */
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

/** A resolved object. `score: 1` is exact-match confidence, not similarity. */
function objectStateCard(state: ObjectState): EvidenceCard {
  // The request supplied this exact reference, so the card is the object.
  const object = cardIsObjectRef(state);

  if (!object) {
    // The identity sanitized to nothing, so it cannot be cited.
    return missingObjectCard(
      state.objectId,
      "The stored object identity could not be read; state is unavailable.",
    );
  }

  // Read back off the ref, so the citation uses the same bounded values.
  const { kind, externalId, nativeState, title, url, repo } = object;

  const citation: EvidenceCitation = {
    label:
      boundCardText(title, EVIDENCE_CITATION_LABEL_MAX_CHARS) ??
      `${integrationDisplayName(state.provider)} ${kind}`,
    ...(url ? { url } : {}),
    locator: boundCardText(repo ?? `${kind} ${externalId}`, 500) ?? state.objectId,
  };

  const authority = sourceAuthorityFromManifest(objectStateManifest());

  return {
    id: `${OBJECT_STATE_CONTEXT_SOURCE_ID}:${state.objectId}`,
    source: sourceRefFromManifest(objectStateManifest()),
    mediaKind: "text",
    snippet: objectStateSnippet(state, title, nativeState, repo),
    score: 1,
    object,
    ...(authority !== undefined ? { authority } : {}),
    // No delivery instant means freshness is unknown.
    time: state.stateDeliveredAt
      ? { observedAt: state.stateDeliveredAt.toISOString(), freshness: "ingested" }
      : { freshness: "unknown" },
    citations: [citation],
    expansion: {
      sourceId: OBJECT_STATE_CONTEXT_SOURCE_ID,
      kind: "integration_object" satisfies BuiltInExpansionKind,
      ref: state.objectId,
      ...(title ? { hint: boundCardText(title, 300) } : {}),
    },
  };
}

/** An unresolved reference. Never invents a lifecycle. `score: 0` lets the ranker demote it. */
function missingRefCard(ref: ContextObjectRef, note: string): EvidenceCard {
  // Hash the reference: a key ref can exceed the 512-char id cap, and truncation could merge two.
  const identity =
    ref.by === "key"
      ? { by: ref.by, provider: ref.provider, keyKind: ref.keyKind, keyValue: ref.keyValue }
      : { by: ref.by, provider: ref.provider, kind: ref.kind, externalId: ref.externalId };

  return missingCard(
    `${OBJECT_STATE_CONTEXT_SOURCE_ID}:missing:${sha256Canonical(identity)}`,
    note,
  );
}

function missingObjectCard(objectId: string, note: string): EvidenceCard {
  return missingCard(`${OBJECT_STATE_CONTEXT_SOURCE_ID}:${objectId}`, note);
}

function missingCard(id: string, note: string): EvidenceCard {
  const authority = sourceAuthorityFromManifest(objectStateManifest());

  return {
    // Defensive bound only. The hash keeps distinct refs distinct.
    id: boundCardText(id, 512) ?? `${OBJECT_STATE_CONTEXT_SOURCE_ID}:unresolved`,
    source: sourceRefFromManifest(objectStateManifest()),
    mediaKind: "text",
    score: 0,
    ...(authority !== undefined ? { authority } : {}),
    note: boundCardText(note, EVIDENCE_NOTE_MAX_CHARS) ?? "Object state is unavailable.",
    time: { freshness: "unknown" },
  };
}

function objectStateSnippet(
  state: ObjectState,
  title: string | undefined,
  nativeState: string | undefined,
  repo: string | undefined,
): string {
  const label = title ?? `${state.kind} ${state.externalId}`;
  const where = repo ? ` (${repo})` : "";
  const reading = nativeState ?? "state unknown";

  return (
    boundCardText(`${label}${where}: ${reading}`, EVIDENCE_SNIPPET_MAX_CHARS) ?? "Object state"
  );
}
