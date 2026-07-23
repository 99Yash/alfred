/**
 * The one authenticated `fetch` transport the *curated* provider clients share
 * (Vercel, Notion, GitHub, Railway). It owns exactly the mechanism those four
 * had each copied inline — bearer/version headers pinned by the caller, the
 * shared {@link INTEGRATION_FETCH_TIMEOUT_MS} timeout, JSON body encoding, and
 * redirect policy — and nothing else. It returns the raw {@link Response} so
 * each vendor keeps its own genuinely-different post-fetch step (parse as JSON,
 * `zod`-validate, or hand back the raw text envelope) and its own error mapping.
 *
 * This is the curated-tier sibling of {@link restPassthroughFetch} (the general
 * read-only passthrough transport) and `googleJson` (the Google mini-core): the
 * same "data-only profile + request" shape, so the 30s timeout and header
 * mechanics live in one place per tier instead of five.
 *
 * A transport failure (timeout/DNS/reset/TLS) throws for the caller to classify;
 * a non-2xx does not — the returned `Response` carries `ok`/`status` and the
 * caller decides how to surface it.
 */

/** Shared request timeout for every curated integration client call. */
export const INTEGRATION_FETCH_TIMEOUT_MS = 30_000;

/**
 * Per-provider transport policy — the data-only inputs pinning auth + wire
 * behavior. Carries no URL or business logic; that lives in the vendor module.
 */
export interface AuthedFetchProfile {
  /**
   * Pinned request headers (authorization + any provider/version/accept the API
   * mandates). `Content-Type: application/json` is added by the transport only
   * when a body is sent, so it must not be listed here.
   */
  headers: Record<string, string>;
  /**
   * Redirect handling. Defaults to `"follow"`. GraphQL/passthrough-style callers
   * pass `"manual"`: a signed provider redirect can carry credentials in its URL,
   * so a 3xx should be treated as an HTTP outcome, not silently followed.
   */
  redirect?: "follow" | "error" | "manual";
  /** Request timeout; defaults to {@link INTEGRATION_FETCH_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** A single authenticated request. `body`, when present, is JSON-encoded. */
export interface AuthedFetchRequest {
  url: string | URL;
  /** HTTP method; defaults to `"GET"`. */
  method?: string;
  /**
   * Request body. When defined it is `JSON.stringify`-ed and the transport adds
   * `Content-Type: application/json`; when omitted no body or content type is
   * sent (a bare read).
   */
  body?: unknown;
}

/**
 * Issue an authenticated request with the provider's pinned headers, the shared
 * timeout, and JSON body encoding. Returns the raw {@link Response} untouched.
 */
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
    body: hasBody ? JSON.stringify(request.body) : undefined,
    redirect: profile.redirect ?? "follow",
    signal: AbortSignal.timeout(profile.timeoutMs ?? INTEGRATION_FETCH_TIMEOUT_MS),
  });
}
