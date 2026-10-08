import { type ErrorBodyPolicy } from "@alfred/contracts";

import { authedFetch } from "./authed-fetch";
import { fetchWithRetry, isRetrySafeMethod, type RetryPolicy } from "./retry";
import { throwUpstreamError } from "./upstream-error";

/**
 * Shared JSON client for providers: fresh auth, URL, retry, non-2xx to HttpError, parse as `unknown`.
 * `resolve()` runs on every request so short-lived tokens stay fresh.
 * Not for binary responses or non-JSON envelopes such as GraphQL `{data,errors}`.
 */

/** `undefined` values are dropped from the URL. */
export type QueryValue = string | number | boolean | undefined;

export interface ProviderRequestContext {
  /** Includes the auth token, already unwrapped. */
  headers: Record<string, string>;
  /** Query on every request (Vercel's `teamId`). Merged last, so a caller cannot override it. */
  fixedQuery?: Record<string, string> | undefined;
}

export interface ProviderClientConfig {
  provider: string;
  baseUrl: string;
  /** Called on every request. Do not cache a token here. */
  resolve: () => Promise<ProviderRequestContext>;
  /** Required, so no provider retries by accident. `"none"` means one attempt. */
  retry: RetryPolicy | "none";
  /**
   * How much of a non-2xx body may ride on the thrown error.
   * Required: the default sends a body into telemetry, so absence must not mean "on".
   */
  bodyPolicy: ErrorBodyPolicy;
}

export interface ProviderRequest {
  method?: string | undefined;
  query?: Record<string, QueryValue> | undefined;
  body?: unknown;
  /** Path label for the thrown error, so the error never carries a token-bearing URL. */
  label?: string | undefined;
  /**
   * Let a non-safe method retry. Set it only when the request cannot double-apply
   * (an idempotency key, or a full replace). Optional because absence is the safe answer.
   */
  idempotent?: true | undefined;
}

export interface ProviderClient {
  /** Returns parsed JSON as `unknown`. An empty body gives `{}`; a non-2xx throws {@link HttpError}. */
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

  for (const [key, value] of Object.entries(fixedQuery ?? {})) {
    url.searchParams.set(key, value);
  }

  return url;
}

export function defineProviderClient(config: ProviderClientConfig): ProviderClient {
  return {
    async json(path, request = {}) {
      const { headers, fixedQuery } = await config.resolve();
      const url = buildUrl(config.baseUrl, path, request.query, fixedQuery);

      const send = () =>
        authedFetch({ headers }, { url, method: request.method, body: request.body });

      // The method decides eligibility: a POST that times out after it arrived must not be re-sent.
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

      return text ? JSON.parse(text) : {};
    },
  };
}
