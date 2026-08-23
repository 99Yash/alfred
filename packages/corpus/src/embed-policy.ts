import type { Chunk } from "./chunker";

export { EMBED_COST_CAP_USD, maxTokensForPrice } from "@alfred/contracts/pricing";

/** What `capChunksForBudget` returns: the kept prefix plus honest counts. */
export interface EmbedBudgetSlice {
  chunks: Chunk[];
  hashes: string[];
  /** True when the input exceeded `maxTokens` and was cut to its longest fitting prefix. */
  truncated: boolean;
  /** How many chunks survived the cap. */
  kept: number;
  /** Total tokens across ALL input chunks, counted before capping. */
  total: number;
}

/**
 * Keep the longest prefix of `chunks` whose token sum fits `maxTokens`.
 * Pure: slices into fresh arrays and never mutates the inputs, and it logs
 * nothing — the caller owns every observable. An empty result is legal and
 * means even the first chunk exceeds the budget.
 */
export function capChunksForBudget(
  chunks: readonly Chunk[],
  hashes: readonly string[],
  maxTokens: number,
): EmbedBudgetSlice {
  const total = chunks.reduce((sum, c) => sum + c.tokenCount, 0);
  if (total <= maxTokens) {
    return {
      chunks: [...chunks],
      hashes: [...hashes],
      truncated: false,
      kept: chunks.length,
      total,
    };
  }
  let used = 0;
  let keep = 0;
  for (const c of chunks) {
    if (used + c.tokenCount > maxTokens) break;
    used += c.tokenCount;
    keep++;
  }
  return {
    chunks: chunks.slice(0, keep),
    hashes: hashes.slice(0, keep),
    truncated: true,
    kept: keep,
    total,
  };
}
