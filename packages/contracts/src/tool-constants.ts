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
