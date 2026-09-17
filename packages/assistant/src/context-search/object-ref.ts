import {
  EVIDENCE_CITATION_URL_MAX_CHARS,
  sanitizeErrorMessage,
  type EvidenceObjectRef,
  type EvidenceObjectRelation,
} from "@alfred/contracts";
import type { ObjectState, ReconciledObject } from "@alfred/assistant/connections";

/**
 * The one mapping from reducer-owned {@link ObjectState} to the card contract's
 * {@link EvidenceObjectRef} (#1087).
 *
 * Two Context Search sources now attach an object: the object-state source
 * carries the caller's own resolved reference, and the document source
 * annotates a chunk whose text named one. Before this module the first one
 * owned the mapping inline, so the second would have copied the per-field
 * bound, the empty-collapses-to-omitted rule, and the "a URL over the citation
 * cap is omitted, never truncated" rule. One owner means a third source
 * inherits all three instead of restating two of them.
 *
 * It asserts nothing about lifecycle: `stateCategory` is copied from the
 * projection and is never read out of text (ADR-0062's propose/dispose
 * contract).
 *
 * **The relation is bound to the entry point, never passed in.** There are two
 * exported builders and no parameter that selects between them, because the
 * relation is the one field a caller cannot be trusted to state: `is` turns on
 * the ranker's exact-retrieval feature, and a producer that reached its object
 * through text would pass the word that claims a retrieval mode it did not
 * use. A free `relation` argument makes that a plausible-looking call; two
 * entry points make it unwritable. {@link cardNamesObjectRef} takes the
 * {@link ReconciledObject} the reconcile seam returns rather than a bare
 * `ObjectState`, so only a caller that actually went through the seam can mint
 * a `names` ref at all.
 */

/**
 * Bound and strip poison from one provider string, collapsing an empty result
 * to `undefined` so it is omitted rather than emitted as `""`. A card field the
 * schema bounds is built through this, so a NUL or a surrogate in provider text
 * cannot reject the whole card it rides on.
 */
export function boundCardText(
  value: string | null | undefined,
  maxChars: number,
): string | undefined {
  if (value === null || value === undefined) return undefined;

  return sanitizeErrorMessage(value, maxChars) || undefined;
}

/**
 * The card IS this object: the caller resolved its own exact reference, so the
 * card was reached by an exact key rather than by similarity.
 *
 * `undefined` is the honest return rather than a partially built ref: a card
 * cannot cite an object with an empty `kind` or `externalId`. A caller that
 * owes the reader an explanation emits a note card instead.
 */
export function cardIsObjectRef(state: ObjectState): EvidenceObjectRef | undefined {
  return objectRef(state, "is");
}

/**
 * The card's own text NAMES this object: the card was reached by similarity and
 * the object is an annotation on it.
 *
 * The parameter is the reconcile seam's own {@link ReconciledObject} rather
 * than the `ObjectState` inside it. That is the whole point of the second entry
 * point: a producer that reached an object through text has one, and a producer
 * that did not cannot manufacture one, so the `names` relation is unreachable
 * from any other path. `undefined` is returned for the same reason as
 * {@link cardIsObjectRef}; a caller that only annotates attaches nothing.
 */
export function cardNamesObjectRef(object: ReconciledObject): EvidenceObjectRef | undefined {
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

  // A URL longer than the citation cap is not cited rather than truncated into
  // a link that no longer resolves (the document adapter's rule). It still goes
  // through `boundCardText` so NUL/surrogate poison cannot ride the raw field
  // into the card.
  const url =
    state.url !== null && state.url.length <= EVIDENCE_CITATION_URL_MAX_CHARS
      ? boundCardText(state.url, EVIDENCE_CITATION_URL_MAX_CHARS)
      : undefined;

  return {
    provider: state.provider,
    kind,
    externalId,
    relation,
    stateCategory: state.stateCategory,
    ...(nativeState ? { nativeState } : {}),
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
    ...(repo ? { repo } : {}),
  };
}
