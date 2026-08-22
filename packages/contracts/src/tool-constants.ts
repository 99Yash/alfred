/**
 * Cross-boundary tool constants. Keep values here only when the model-facing
 * schema, server result shaping, and/or client rendering must agree.
 */

/** Public `gmail.search` query length cap. */
export const GMAIL_SEARCH_QUERY_MAX_CHARS = 500;

/** Default number of Gmail hits returned when the model omits/garbles maxResults. */
export const GMAIL_SEARCH_DEFAULT_RESULTS = 10;

/** Public `gmail.search` result cap exposed to the model. */
export const GMAIL_SEARCH_MAX_RESULTS = 50;

/** One-line preview cap for `gmail.search` hits. */
export const GMAIL_SEARCH_SNIPPET_MAX_CHARS = 200;

/**
 * Hard cap on the sanitized text `system.fetch_url` returns. The tool truncates
 * to this with a `truncated` flag, and PDF extraction for the same tool sizes
 * its output limit against it (the parser may read farther so the caller can
 * truncate an otherwise valid document instead of failing it) — so the tool
 * runtime and `@alfred/extraction` must agree on this value.
 */
export const FETCH_URL_MAX_TEXT_CHARS = 100_000;
