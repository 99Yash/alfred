import type { Redacted } from "@alfred/contracts";

/**
 * The GitHub REST authority — origin plus the headers every request to it needs
 * — declared once for the whole `github/` folder.
 *
 * It exists because the origin and the `Accept`/API-version/`User-Agent` triple
 * were restated in `app.ts` (App-JWT calls, the passthrough profile) and in
 * `client.ts` (the curated read client). Two copies of "who we are to GitHub"
 * is one copy too many: a version bump or a `User-Agent` change is a domain
 * change with exactly one right answer, so it gets exactly one home.
 */

/** Pinned REST origin. The model never supplies an origin; this is the only one. */
export const GITHUB_API = "https://api.github.com";

/** Non-auth headers GitHub requires on every REST call (it 403s without a `User-Agent`). */
export const GITHUB_REST_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "alfred-app",
} as const;

/**
 * The single place an installation token is unwrapped: the moment it becomes an
 * `Authorization` header. Taking a {@link Redacted} rather than a `string` is
 * what makes that a property of the type instead of a review-time rule — a
 * caller cannot reach the plaintext without writing `.unwrap()`, and this is the
 * only file that does.
 */
export function githubHeaders(token: Redacted<string>): Record<string, string> {
  return { ...GITHUB_REST_HEADERS, Authorization: `Bearer ${token.unwrap()}` };
}
