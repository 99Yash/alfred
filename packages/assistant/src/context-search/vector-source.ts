import type { EvidenceSourceRef } from "@alfred/contracts";

/**
 * The shared helpers of a vector-backed context source (#424; epic #422).
 *
 * Both built-in adapters wrap a retrieval primitive that returns hits carrying
 * a stable chunk id and a cosine similarity, then map each hit to a card. The
 * helpers here are that common shape — the ordering, the honest-content
 * fallback, and the internal source ref — so the two adapters cannot drift and
 * a third vector source does not retype them. Cross-source ranking is
 * `rank.ts` (#427); these helpers only keep one source's own output
 * deterministic, which is what the ranker's per-source score normalization
 * needs from an adapter.
 */

/**
 * Deterministic source-local order: highest similarity first, chunk id as the
 * tie-break so an equal-score pair never flips between reads. The id comparison
 * is by code unit, not locale: `localeCompare` answers differently under
 * different ICU data, while a tie-break only has to be total and stable. The
 * constraint is the minimal intersection both retrieval primitives already
 * satisfy — a structural bound, not a shape either of them parses into. The
 * cross-source ranker (#427) reorders these cards afterwards; this only fixes
 * the order a single source hands over, so a source cannot be nondeterministic.
 */
export function compareByScoreThenId<THit extends { chunkId: string; similarity: number }>(
  a: THit,
  b: THit,
): number {
  const diff = b.similarity - a.similarity;

  // A NaN similarity carries no order, so it falls through to the stable id
  // tie-break rather than poisoning the sort with a NaN return.
  if (!Number.isNaN(diff) && diff !== 0) return diff;

  if (a.chunkId === b.chunkId) return 0;

  return a.chunkId < b.chunkId ? -1 : 1;
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
