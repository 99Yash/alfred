// Server-only AI prices and provider limits. Values the browser reads live in `@alfred/contracts`.

import { APPROXIMATE_CHARS_PER_TOKEN } from "./token-estimate";

// New code should import this from `@alfred/contracts/pricing`.
export { VOYAGE_INPUT_PRICE_PER_MTOK_USD_DEFAULT } from "@alfred/contracts/pricing";

export const BATCH_CHARS_PER_TOKEN = APPROXIMATE_CHARS_PER_TOKEN;

/** Voyage embedding dimensions (ADR-0021). */
export const EMBEDDING_DIMENSIONS = 1024;

/** Voyage per-request batch limits. */
export const VOYAGE_MAX_BATCH_INPUTS = 1000;

export const VOYAGE_MAX_BATCH_TOKENS = 120_000;
