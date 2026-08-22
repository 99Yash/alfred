/**
 * Client-visible bounds for `GET /api/me/inbox`. Both sides of the seam import
 * these: `@alfred/http` clamps the query param, and the web rail paginates with
 * the default as its page size. One home so a tuning change cannot drift into a
 * server-only edit the client never learns about.
 */

/** Page size when the caller sends no `limit` (and the web rail's page size). */
export const INBOX_DEFAULT_LIMIT = 8;

/** Hard upper bound on `limit` per request. */
export const INBOX_MAX_LIMIT = 50;
