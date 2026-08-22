import type { Chunk } from "./chunker";

/**
 * Per-`indexDocument` embed spend ceiling, in USD.
 *
 * Policy (decided 2026-08, architecture review candidate 2): the cap governs
 * the new-chunk set a single `indexDocument` invocation sends — which
 * `embedMany` may split across several Voyage requests at the provider's
 * per-request limits — not the document lifetime. When the cap truncates,
 * the caller marks the document terminal for the sweep (`embed_failed_at`
 * + a `last_embed_error` reason) so a capped tail is a durable, visible
 * decision instead of a silent one. An explicit re-index still makes
 * progress, because each call caps only the chunks that do not already
 * match stored hashes.
 */
export const EMBED_COST_CAP_USD = 0.5;

/**
 * Convert a provider price into the token budget the cap buys. Pure math over
 * the injected price — the policy never imports a provider constant, so a
 * test (or a future provider) can inject any price and assert the budget.
 */
export function maxTokensForPrice(pricePerMtokUsd: number): number {
  return Math.floor((EMBED_COST_CAP_USD / pricePerMtokUsd) * 1_000_000);
}

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
