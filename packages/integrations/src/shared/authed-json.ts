import { type ErrorBodyPolicy } from "@alfred/contracts";

import { authedFetch, type AuthedFetchProfile, type AuthedFetchRequest } from "./authed-fetch";
import { fetchWithRetry, isRetrySafeMethod, type RetryPolicy } from "./retry";
import { throwUpstreamError } from "./upstream-error";

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
  urlLabel?: string | undefined;
  /**
   * How much of a non-2xx body rides on the thrown {@link HttpError}. Defaults
   * to `"summarize"` (a bounded, secret-redacted slice). Pass `"omit"` for a
   * provider whose body can echo request fragments (Notion) that must never
   * reach the tool dispatcher / model transcript: the body is instead logged
   * server-side here and the thrown error carries none. See {@link ErrorBodyPolicy}.
   */
  bodyPolicy?: ErrorBodyPolicy | undefined;
  /** Explicit retry posture; non-safe methods require `idempotent: true`. */
  retry?: RetryPolicy | "none" | undefined;
  idempotent?: true | undefined;
}

/**
 * Issue an authenticated request via {@link authedFetch}, then: throw on a
 * non-2xx via {@link throwUpstreamError} (which honors
 * {@link AuthedJsonOptions.bodyPolicy}), else parse the JSON body. A `204`/empty
 * body resolves to `{}`. A transport failure (timeout/DNS/reset/TLS) propagates
 * from `authedFetch` unchanged.
 */
export async function authedJson(
  profile: AuthedFetchProfile,
  request: AuthedFetchRequest,
  options: AuthedJsonOptions,
): Promise<unknown> {
  const send = () => authedFetch(profile, request);
  const eligible = options.idempotent === true || isRetrySafeMethod(request.method);
  const res =
    options.retry && options.retry !== "none" && eligible
      ? await fetchWithRetry(send, { policy: options.retry })
      : await send();
  if (!res.ok) {
    return throwUpstreamError({
      provider: options.provider,
      res,
      url: options.urlLabel ?? String(request.url),
      method: request.method,
      bodyPolicy: options.bodyPolicy,
    });
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}
