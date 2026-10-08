import { type ErrorBodyPolicy } from "@alfred/contracts";

import { authedFetch, type AuthedFetchProfile, type AuthedFetchRequest } from "./authed-fetch";
import { fetchWithRetry, isRetrySafeMethod, type RetryPolicy } from "./retry";
import { throwUpstreamError } from "./upstream-error";

/**
 * `authedFetch` plus throw-on-non-2xx and JSON parse. Returns `unknown`: the caller
 * validates it with a schema, never a cast.
 */

export interface AuthedJsonOptions {
  provider: string;
  /** Defaults to the request URL. Pass a path when the URL could carry query secrets. */
  urlLabel?: string | undefined;
  /**
   * Default `"summarize"`. Use `"omit"` when error bodies can echo request fragments
   * (Notion): the body is logged here and the error carries none.
   */
  bodyPolicy?: ErrorBodyPolicy | undefined;
  /** A non-safe method also needs `idempotent: true` to retry. */
  retry?: RetryPolicy | "none" | undefined;
  idempotent?: true | undefined;
}

/** An empty body gives `{}`. A transport failure propagates unchanged. */
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
