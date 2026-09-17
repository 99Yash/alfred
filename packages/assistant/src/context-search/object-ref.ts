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
 * the ranker's exact-retrieval feature at weight `0.08`, and a producer that
 * reached its object through text would pass the word that claims a retrieval
 * mode it did not use. A free `relation` argument makes that a
 * plausible-looking call. Two entry points make the wrong relation a
 * deliberately chosen FUNCTION rather than a mistyped argument.
 *
 * **That binding is naming plus convention, not the type system. Read this
 * before you add the third source.** Nothing here is unwritable:
 *
 * - {@link ReconciledObject} is a structural type of three public fields, so a
 *   producer that never called the reconcile seam can still write the literal
 *   and reach {@link cardNamesObjectRef}. Passing the seam's result buys a
 *   reviewer's signal, not a compiler's refusal.
 * - The dangerous direction is the cheaper one. A document builder already
 *   holds an `ObjectState` inside its {@link ReconciledObject}, so
 *   `cardIsObjectRef(object.state)` is one import away, compiles, parses, and
 *   turns `exactMatch = 1` on for a card that similarity reached. The two entry
 *   points do not close that; only this paragraph and the call-site comments
 *   do.
 *
 * So the rule a new source must carry itself: call {@link cardIsObjectRef} only
 * when the CALLER supplied the exact reference the lookup used. If the card was
 * reached by similarity, by a key parsed out of text, or by any other search,
 * the relation is `names`.
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
 * Call this ONLY from a source whose lookup key came from the request. The
 * `is` relation turns on the ranker's `exactMatch` feature, which asserts a
 * retrieval mode rather than a fact about the object, and no type here refuses
 * the wrong caller — see the module docstring.
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
 * than the `ObjectState` inside it, so the natural call is the one the seam
 * already hands you. It is a structural type, so it does not PREVENT a
 * producer that skipped the seam from writing the literal; it only makes that
 * producer write three fields it has no honest source for.
 *
 * `undefined` is returned for the same reason as {@link cardIsObjectRef}; a
 * caller that only annotates attaches nothing.
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
