/**
 * The one authenticated `fetch` for integration clients: pinned headers, the shared
 * timeout, JSON body, redirect policy. Returns the raw `Response`; a non-2xx does not
 * throw, a transport failure does. `authedJson` and `restPassthroughFetch` build on it.
 */

export const INTEGRATION_FETCH_TIMEOUT_MS = 30_000;

export interface AuthedFetchProfile {
  /** Do not list `Content-Type`: the transport adds it when a body is sent. */
  headers: Record<string, string>;
  /** Default `"follow"`. Use `"manual"` when a signed redirect URL could carry credentials. */
  redirect?: "follow" | "error" | "manual" | undefined;
}

export interface AuthedFetchRequest {
  url: string | URL;
  method?: string | undefined;
  /** JSON-encoded when defined. */
  body?: unknown;
  /** Caller abort, combined with the shared timeout. */
  signal?: AbortSignal | undefined;
}

export async function authedFetch(
  profile: AuthedFetchProfile,
  request: AuthedFetchRequest,
): Promise<Response> {
  const hasBody = request.body !== undefined;

  return fetch(request.url, {
    method: request.method ?? "GET",
    headers: {
      ...profile.headers,
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
    redirect: profile.redirect ?? "follow",
    signal:
      request.signal === undefined
        ? AbortSignal.timeout(INTEGRATION_FETCH_TIMEOUT_MS)
        : AbortSignal.any([AbortSignal.timeout(INTEGRATION_FETCH_TIMEOUT_MS), request.signal]),
  });
}
