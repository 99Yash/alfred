import type { Chunk } from "./chunker";

// New code should import these from `@alfred/contracts/pricing`.
export { EMBED_COST_CAP_USD, maxTokensForPrice } from "@alfred/contracts/pricing";

/** The kept prefix and its counts. */
export interface EmbedBudgetSlice {
  chunks: Chunk[];
  hashes: string[];
  /** The input exceeded `maxTokens`. */
  truncated: boolean;
  /** Chunks kept. */
  kept: number;
  /** Tokens across all input chunks, before the cap. */
  total: number;
}

/** Keep the longest prefix that fits `maxTokens`. Empty means the first chunk is too big. */
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
