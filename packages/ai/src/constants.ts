/**
 * AI module constants — cost, rate limits, and batch sizing.
 *
 * This file is the single owner for hard-coded AI pricing and provider
 * limits. Logic files import from here; never hard-code a price or limit
 * inline. Cross-seam values that the browser must also read belong in
 * `@alfred/contracts`; this file holds server-only AI constants.
 */

import { APPROXIMATE_CHARS_PER_TOKEN } from "./token-estimate";

/** Batch sizing mirrors the corpus chunker — same heuristic, separate name for intent. */
export const BATCH_CHARS_PER_TOKEN = APPROXIMATE_CHARS_PER_TOKEN;

/** Voyage embedding dimensions (ADR-0021). */
export const EMBEDDING_DIMENSIONS = 1024;

/** Fallback Voyage input price per million tokens when env var is unset. */
export const VOYAGE_INPUT_PRICE_PER_MTOK_USD_DEFAULT = 0.06;

/** Voyage per-request batch limits. */
export const VOYAGE_MAX_BATCH_INPUTS = 1000;
export const VOYAGE_MAX_BATCH_TOKENS = 120_000;
