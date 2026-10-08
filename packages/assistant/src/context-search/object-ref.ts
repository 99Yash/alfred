import {
  EVIDENCE_CITATION_URL_MAX_CHARS,
  sanitizeErrorMessage,
  type EvidenceObjectRef,
  type EvidenceObjectRelation,
} from "@alfred/contracts";
import type { ObjectState, ReconciledObject } from "@alfred/assistant/connections";

/**
 * The one mapping from {@link ObjectState} to {@link EvidenceObjectRef} (#1087).
 * `stateCategory` comes from the projection, never from text (ADR-0062).
 *
 * The relation is fixed by which builder you call, never passed in, because
 * `is` turns on the ranker's `exactMatch`. Types do not enforce this:
 * `cardIsObjectRef(object.state)` compiles from a document source. Call
 * {@link cardIsObjectRef} only when the request supplied the exact lookup key.
 * Anything reached by similarity or by a key parsed from text is `names`.
 */

/** Bound and sanitize provider text. Empty becomes `undefined`, so a bad string cannot fail the card. */
export function boundCardText(
  value: string | null | undefined,
  maxChars: number,
): string | undefined {
  if (value === null || value === undefined) return undefined;

  return sanitizeErrorMessage(value, maxChars) || undefined;
}

/**
 * The card is this object, found by an exact key from the request.
 * `undefined` when `kind` or `externalId` is empty.
 */
export function cardIsObjectRef(state: ObjectState): EvidenceObjectRef | undefined {
  return objectRef(state, "is");
}

/**
 * The card's text names this object; similarity found the card.
 * Takes only the `annotates` reading, so an `about` or `mentions` result is refused.
 */
export function cardNamesObjectRef(
  object: ReconciledObject<"annotates">,
): EvidenceObjectRef | undefined {
  return objectRef(object.state, "names");
}

/** The shared field mapping. Private, so the relation cannot be chosen here. */
function objectRef(
  state: ObjectState,
  relation: EvidenceObjectRelation,
): EvidenceObjectRef | undefined {
  const kind = boundCardText(state.kind, 100);
  const externalId = boundCardText(state.externalId, 512);

  if (!kind || !externalId) return undefined;

  const nativeState = boundCardText(state.nativeState, 200);
  const title = boundCardText(state.title, 500);
  const repo = boundCardText(state.repo, 300);

  // Omit an over-cap URL: a truncated link does not resolve.
  const url =
    state.url !== null && state.url.length <= EVIDENCE_CITATION_URL_MAX_CHARS
      ? boundCardText(state.url, EVIDENCE_CITATION_URL_MAX_CHARS)
      : undefined;

  // `names` only: an `is` card already shows this instant as `time.observedAt`.
  const stateDeliveredAt =
    relation === "names" && state.stateDeliveredAt !== null
      ? state.stateDeliveredAt.toISOString()
      : undefined;

  return {
    provider: state.provider,
    kind,
    externalId,
    relation,
    stateCategory: state.stateCategory,
    ...(stateDeliveredAt ? { stateDeliveredAt } : {}),
    ...(nativeState ? { nativeState } : {}),
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
    ...(repo ? { repo } : {}),
  };
}
