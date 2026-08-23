/**
 * Pricing seam — embed cost and provider price.
 *
 * This file is the single owner for the embed pricing policy that `ai` and
 * `corpus` previously split. Keep hard coded pricing here; never hard code
 * a price or USD cap in a logic file. Browser and server share this seam
 * so the cap is visible outside `corpus` (architecture review candidate 3).
 *
 * - `VOYAGE_INPUT_PRICE_PER_MTOK_USD_DEFAULT` — fallback Voyage price when
 *   `VOYAGE_INPUT_PRICE_PER_MTOK_USD` is unset. The server adapter
 *   `voyageInputPricePerMtokUsd()` in `@alfred/ai` reads `serverEnv()` and
 *   falls back to this default.
 * - `EMBED_COST_CAP_USD` — per-`indexDocument` spend ceiling. The corpus
 *   policy caps the *new*-chunk set, not the document lifetime.
 * - `maxTokensForPrice` — pure derivation of the token budget the cap buys.
 */

export const VOYAGE_INPUT_PRICE_PER_MTOK_USD_DEFAULT = 0.06;

export const EMBED_COST_CAP_USD = 0.5;

/**
 * Convert a provider price into the token budget the cap buys. Pure math over
 * the injected price — the policy never imports a provider constant, so a
 * test (or a future provider) can inject any price and assert the budget.
 */
export function maxTokensForPrice(pricePerMtokUsd: number): number {
  return Math.floor((EMBED_COST_CAP_USD / pricePerMtokUsd) * 1_000_000);
}
