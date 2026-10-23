import { type ErrorBodyPolicy } from "@alfred/contracts";
import { z } from "zod";

import { authedFetch, type AuthedFetchProfile, type AuthedFetchRequest } from "./authed-fetch";
import { fetchWithRetry, isRetrySafeMethod, type RetryPolicy } from "./retry";
import { throwUpstreamError } from "./upstream-error";

/**
 * `authedFetch` plus throw-on-non-2xx, JSON parse, and a schema parse. The schema is
 * required, so an unvalidated response cannot reach a caller.
 */

/** For calls that only need success. Passing it says "response unchecked" out loud. */
export const uncheckedResponse: z.ZodType<unknown> = z.unknown();

export interface AuthedJsonOptions {
  provider: string;
  /** Defaults to the request URL. Pass a path when the URL could carry query secrets. */
  urlLabel?: string | undefined;
  /**
   * Default `"summarize"`. Use `"omit"` when error bodies can echo request fragments:
   * the body is logged here and the error carries none.
   */
  bodyPolicy?: ErrorBodyPolicy | undefined;
  /** A non-safe method also needs `idempotent: true` to retry. */
  retry?: RetryPolicy | "none" | undefined;
  idempotent?: true | undefined;
}

/**
 * An empty body gives `{}`. A transport failure propagates unchanged. A schema mismatch
 * throws `ZodError` after the response arrives, so it never retries.
 */
export async function authedJson<T>(
  schema: z.ZodType<T>,
  profile: AuthedFetchProfile,
  request: AuthedFetchRequest,
  options: AuthedJsonOptions,
): Promise<T> {
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

  return schema.parse(text ? JSON.parse(text) : {});
}
