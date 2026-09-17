import {
  EVIDENCE_CITATION_URL_MAX_CHARS,
  sanitizeErrorMessage,
  type EvidenceObjectRef,
  type EvidenceObjectRelation,
} from "@alfred/contracts";
import type { ObjectState } from "@alfred/assistant/connections";

/**
 * The one mapping from reducer-owned {@link ObjectState} to the card contract's
 * {@link EvidenceObjectRef} (#1087).
 *
 * Two Context Search sources now attach an object: the object-state source
 * carries the caller's own resolved reference (`relation: "is"`), and the
 * document source annotates a chunk whose text named one (`relation:
 * "mentions"`). Before this module the first one owned the mapping inline, so
 * the second would have copied the per-field bound, the empty-collapses-to-
 * omitted rule, and the "a URL over the citation cap is omitted, never
 * truncated" rule. One owner means a third source inherits all three instead
 * of restating two of them.
 *
 * It asserts nothing about lifecycle: `stateCategory` is copied from the
 * projection and is never read out of text (ADR-0062's propose/dispose
 * contract). The caller states the relation, because only the caller knows how
 * it reached the object.
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
 * One projected object as a card's `object` field, or `undefined` when its
 * stored identity text sanitizes to nothing.
 *
 * `undefined` is the honest return rather than a partially built ref: a card
 * cannot cite an object with an empty `kind` or `externalId`. A caller that
 * owes the reader an explanation emits a note card instead; a caller that only
 * annotates attaches nothing.
 */
export function evidenceObjectRefFromState(
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
