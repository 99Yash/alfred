/** Embed pricing. Put hard-coded prices and USD caps here, never in a logic file. */

/** Used when `VOYAGE_INPUT_PRICE_PER_MTOK_USD` is unset. */
export const VOYAGE_INPUT_PRICE_PER_MTOK_USD_DEFAULT = 0.06;

/** Spend cap per `indexDocument` call, on the new chunks only. */
export const EMBED_COST_CAP_USD = 0.5;

/** The token budget that `EMBED_COST_CAP_USD` buys at this price. */
export function maxTokensForPrice(pricePerMtokUsd: number): number {
  return Math.floor((EMBED_COST_CAP_USD / pricePerMtokUsd) * 1_000_000);
}
