import { httpErrorFromResponse } from "@alfred/contracts";

import { authedFetch } from "./authed-fetch";
import { fetchWithRetry, type RetryPolicy } from "./retry";

/**
 * The one configured-client factory every provider builds on — the shape the
 * GitHub and Vercel clients had each been about to hand-roll. It bakes the
 * repeated skeleton into a single place:
 *
 *   resolve fresh auth  →  build URL (base + path + query + pinned query)
 *     →  fetch with transient retry  →  non-2xx becomes an HttpError
 *     →  parse JSON as `unknown` (the caller zod-validates at its boundary)
 *
 * What stays provider-specific is exactly what should: `resolve()` (each
 * provider's own credential path + header shape) and the per-method path +
 * schema. Everything mechanical is shared.
 *
 * `resolve()` is called on EVERY request, never memoized here — that is what
 * keeps a short-lived token fresh and ensures no secret lives on the client. The
 * token is expected to arrive already unwrapped into `headers` at the wire (the
 * provider unwraps its `Redacted` inside `resolve`), so this layer never sees a
 * bare secret it could log.
 *
 * Deliberately NOT covered here (providers that need them stay bespoke): a raw
 * `Response` (binary/streamed downloads) and non-JSON envelopes (Railway's
 * GraphQL `{data,errors}`). Body-redaction on a non-2xx is NOT bespoke — it is
 * the `bodyPolicy: "omit"` option on `httpErrorFromResponse` (Notion uses it).
 */

/** A query value the URL builder will stringify; `undefined` is dropped. */
export type QueryValue = string | number | boolean | undefined;

/** The per-request auth `resolve()` yields — headers plus any always-on query. */
export interface ProviderRequestContext {
  /** Request headers, including the auth token already unwrapped at the wire. */
  headers: Record<string, string>;
  /**
   * Query pinned on every request (e.g. Vercel's `teamId`). Merged last, so it
   * wins over a per-call `query` and cannot be overridden by a caller.
   */
  fixedQuery?: Record<string, string>;
}

export interface ProviderClientConfig {
  provider: string;
  baseUrl: string;
  /** Resolve fresh per-call auth. Called on every request — never cache a token here. */
  resolve: () => Promise<ProviderRequestContext>;
  retry?: RetryPolicy;
}

export interface ProviderRequest {
  method?: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Redacted path label the thrown error reports (never the token-bearing URL). */
  label?: string;
}

export interface ProviderClient {
  /**
   * Authenticated request → parsed JSON as `unknown` (the caller validates it
   * with a schema at its boundary). A `204`/empty body resolves to `{}`; a
   * non-2xx throws an {@link HttpError}; a transport failure propagates.
   */
  json(path: string, request?: ProviderRequest): Promise<unknown>;
}

function buildUrl(
  baseUrl: string,
  path: string,
  query: Record<string, QueryValue> | undefined,
  fixedQuery: Record<string, string> | undefined,
): URL {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  // Pinned query merged last so a caller can never override it.
  for (const [key, value] of Object.entries(fixedQuery ?? {})) {
    url.searchParams.set(key, value);
  }
  return url;
}

/** Build a configured provider client bound to a fresh-auth `resolve()`. */
export function defineProviderClient(config: ProviderClientConfig): ProviderClient {
  return {
    async json(path, request = {}) {
      const { headers, fixedQuery } = await config.resolve();
      const url = buildUrl(config.baseUrl, path, request.query, fixedQuery);
      const res = await fetchWithRetry(
        () => authedFetch({ headers }, { url, method: request.method, body: request.body }),
        { policy: config.retry },
      );
      if (!res.ok) {
        throw await httpErrorFromResponse(config.provider, res, {
          url: request.label ?? path,
          method: request.method,
        });
      }
      const text = await res.text();
      return text ? (JSON.parse(text) as unknown) : {};
    },
  };
}

export type { RetryPolicy };
