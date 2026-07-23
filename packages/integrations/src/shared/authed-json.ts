import { httpErrorFromResponse } from "@alfred/contracts";

import { authedFetch, type AuthedFetchProfile, type AuthedFetchRequest } from "./authed-fetch";

/**
 * The authenticated-JSON layer built on {@link authedFetch}. It owns the one
 * post-fetch shape the JSON REST clients (Notion, Vercel, Google) each had
 * copied inline: *a non-2xx is an {@link HttpError}, a 2xx is parsed JSON.* The
 * transport mechanics (auth headers, the shared timeout, body encoding, redirect
 * policy) live one layer down in `authedFetch`, so this adds only the
 * throw-and-parse step on top.
 *
 * The two curated clients that genuinely need the raw {@link Response} —
 * `githubGet` (`res.json()` → `zod`) and Railway (its `{ data, errors }`
 * envelope) — stay on `authedFetch` directly; they are not JSON-body-in,
 * parsed-JSON-out calls. Everything that *is* collapses here:
 *
 *   authedFetch  → Response          (github, railway build on this)
 *     └ authedJson → unknown         (notion, vercel, google collapse here)
 *
 * Returns `unknown` on purpose: the caller validates the parsed body with a
 * schema at its own boundary rather than casting `await response.json()` to a
 * local interface (an integrations-package invariant).
 */

export interface AuthedJsonOptions {
  /** Provider tag threaded into the thrown {@link HttpError} for telemetry. */
  provider: string;
  /**
   * Redacted URL label the thrown error reports (never the token-bearing
   * request). Defaults to the request URL; pass a path when the full URL would
   * be noisy or carry query secrets.
   */
  urlLabel?: string;
  /**
   * Override the default non-2xx branch. The default throws an `HttpError`
   * carrying a bounded, secret-redacted slice of the body. Notion overrides it:
   * it logs the body server-side and throws a *body-less* `HttpError` so upstream
   * page fragments never ride the error into the tool dispatcher / telemetry.
   * Receives the non-ok `Response`; must throw (hence `Promise<never>`).
   */
  onError?: (res: Response) => Promise<never>;
}

/**
 * Issue an authenticated request via {@link authedFetch}, then: throw on a
 * non-2xx (default {@link httpErrorFromResponse}, or {@link AuthedJsonOptions.onError}),
 * else parse the JSON body. A `204`/empty body resolves to `{}`. A transport
 * failure (timeout/DNS/reset/TLS) propagates from `authedFetch` unchanged.
 */
export async function authedJson(
  profile: AuthedFetchProfile,
  request: AuthedFetchRequest,
  options: AuthedJsonOptions,
): Promise<unknown> {
  const res = await authedFetch(profile, request);
  if (!res.ok) {
    if (options.onError) return options.onError(res);
    throw await httpErrorFromResponse(options.provider, res, {
      url: options.urlLabel ?? String(request.url),
      method: request.method,
    });
  }
  const text = await res.text();
  return text ? (JSON.parse(text) as unknown) : {};
}
