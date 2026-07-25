import { type ErrorBodyPolicy } from "@alfred/contracts";

import { authedFetch } from "./authed-fetch";
import { fetchWithRetry, isRetrySafeMethod, type RetryPolicy } from "./retry";
import { throwUpstreamError } from "./upstream-error";

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
 * this client's `bodyPolicy` (Notion's `"omit"` posture), applied through the
 * shared {@link throwUpstreamError} branch.
 *
 * Both hazards the skeleton absorbs are represented in the TYPES rather than in
 * this comment, because a seam that reads as "just do the thing" is exactly where
 * a silent hazard survives review: `bodyPolicy` is a config field (so a
 * body-sensitive provider cannot join by forgetting it), `retry` is a REQUIRED
 * config field that can say `"none"` (so no provider retries by accident, and the
 * worst-case wall time of a call is visible where the client is built), and
 * transient retry is gated on {@link isRetrySafeMethod} so a non-idempotent call
 * has to say `idempotent: true` before it can be re-sent.
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
  fixedQuery?: Record<string, string> | undefined;
}

export interface ProviderClientConfig {
  provider: string;
  baseUrl: string;
  /** Resolve fresh per-call auth. Called on every request — never cache a token here. */
  resolve: () => Promise<ProviderRequestContext>;
  /**
   * Transient-retry envelope for this provider's retry-safe requests, or `"none"`
   * for exactly one attempt. Required — see `ProviderBindOptions.retry` in
   * `./provider` for why absence must not mean "retry with a default policy".
   */
  retry: RetryPolicy | "none";
  /**
   * How much of a non-2xx body may ride on the thrown error. A per-PROVIDER
   * property, not a per-call one — a provider whose error bodies can echo request
   * fragments (Notion) sets `"omit"` once here and every method inherits it.
   */
  bodyPolicy?: ErrorBodyPolicy | undefined;
}

export interface ProviderRequest {
  method?: string | undefined;
  query?: Record<string, QueryValue> | undefined;
  body?: unknown;
  /** Redacted path label the thrown error reports (never the token-bearing URL). */
  label?: string | undefined;
  /**
   * Opt a non-retry-safe method into transient retry. Only set this when the
   * request genuinely cannot double-apply — it carries a provider idempotency
   * key, or it replaces state wholesale and the caller ignores the status. Safe
   * methods retry without it; see {@link isRetrySafeMethod}.
   */
  idempotent?: true | undefined;
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
      const send = () =>
        authedFetch({ headers }, { url, method: request.method, body: request.body });
      // Retry is the client's policy but the METHOD decides eligibility: a POST
      // that reaches the upstream and then times out must not be re-sent just
      // because this provider configured a retry envelope.
      const policy = config.retry === "none" ? undefined : config.retry;
      const eligible = request.idempotent === true || isRetrySafeMethod(request.method);
      const res = policy && eligible ? await fetchWithRetry(send, { policy }) : await send();
      if (!res.ok) {
        return throwUpstreamError({
          provider: config.provider,
          res,
          url: request.label ?? path,
          method: request.method,
          bodyPolicy: config.bodyPolicy,
        });
      }
      const text = await res.text();
      return text ? (JSON.parse(text) as unknown) : {};
    },
  };
}

export type { RetryPolicy };
