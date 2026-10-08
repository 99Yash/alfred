/** Tool constants that the model schema, the server, or the client must agree on. */

export const GMAIL_SEARCH_QUERY_MAX_CHARS = 500;

/** Used when the model omits or garbles `maxResults`. */
export const GMAIL_SEARCH_DEFAULT_RESULTS = 10;

export const GMAIL_SEARCH_MAX_RESULTS = 50;

export const GMAIL_SEARCH_SNIPPET_MAX_CHARS = 200;

/** Text cap for `system.fetch_url`. PDF extraction in `@alfred/extraction` sizes its limit from it. */
export const FETCH_URL_MAX_TEXT_CHARS = 100_000;
