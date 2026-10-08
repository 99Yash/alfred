/** Shared helpers for the vector-backed sources (`documents`, `memory`). */

/**
 * Highest similarity first, then chunk id by code unit. `localeCompare` varies
 * with ICU data, so it is not used.
 */
export function compareByScoreThenId<THit extends { chunkId: string; similarity: number }>(
  a: THit,
  b: THit,
): number {
  const diff = b.similarity - a.similarity;

  // A NaN similarity falls through to the id tie-break.
  if (!Number.isNaN(diff) && diff !== 0) return diff;

  if (a.chunkId === b.chunkId) return 0;

  return a.chunkId < b.chunkId ? -1 : 1;
}

/** A snippet when there is text, else the caller's source-specific note. */
export function renderContent(
  preview: string,
  emptyNote: string,
): { snippet: string } | { note: string } {
  return preview.length > 0 ? { snippet: preview } : { note: emptyNote };
}
