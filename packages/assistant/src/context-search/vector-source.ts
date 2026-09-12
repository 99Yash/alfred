import type { EvidenceSourceRef } from "@alfred/contracts";

/**
 * The shared shape of a vector-backed context source (#424; epic #422).
 *
 * Both built-in adapters wrap a retrieval primitive that returns hits carrying
 * a stable chunk id and a cosine similarity, then map each hit to a card. The
 * helpers here are that common shape — the ordering, the honest-content
 * fallback, and the internal source ref — so the two adapters cannot drift and
 * a third vector source does not retype them. Cross-source ranking is #427;
 * these helpers only keep one source's own output deterministic.
 */

/** The fields every retrieval primitive hit exposes to the card mapper. */
export interface VectorHit {
  /** Stable id of the retrieved chunk; the card id is derived from it. */
  readonly chunkId: string;
  /** Cosine similarity in [-1, 1], higher = more similar. */
  readonly similarity: number;
}

/**
 * Deterministic source-local order: highest similarity first, chunk id as the
 * tie-break so an equal-score pair never flips between reads. #427 replaces
 * this with the cross-source ranker.
 */
export function compareByScoreThenId<THit extends VectorHit>(a: THit, b: THit): number {
  return b.similarity - a.similarity || a.chunkId.localeCompare(b.chunkId);
}

/**
 * A card must carry content: a snippet when the chunk has text, an honest note
 * when it does not. The note text differs per source because the empty state
 * means something different on each, so the caller supplies it.
 */
export function renderContent(
  preview: string,
  emptyNote: string,
): { snippet: string } | { note: string } {
  return preview.length > 0 ? { snippet: preview } : { note: emptyNote };
}

/**
 * The source ref for one of Alfred's own stores. `kind: "internal"` is the
 * structural trust signal; the id must equal the producing `ContextSource.id`
 * (enforced at the boundary).
 */
export function internalSourceRef(id: string, displayName: string): EvidenceSourceRef {
  return { id, kind: "internal", displayName };
}
