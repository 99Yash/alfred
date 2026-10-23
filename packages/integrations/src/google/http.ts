import type { z } from "zod";
import { authedJson } from "../shared/authed-json";
import type { RetryPolicy } from "../shared/retry";

/**
 * {@link authedJson} tagged with a Google service. Drive's raw-text download cannot use
 * it (it truncates bytes and sends no JSON `Accept`).
 */

export type GoogleService = "calendar" | "gmail" | "drive" | "docs" | "sheets" | "slides";

export interface GoogleJsonRequest {
  /** Default `"GET"`. */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | undefined;
  url: string;
  accessToken: string;
  /** A POST, PUT, or PATCH sends `payload ?? {}`. GET and DELETE send no body. */
  payload?: unknown;
  /** Default `"none"`. */
  retry?: RetryPolicy | "none" | undefined;
  /** An etag. The provider refuses the write with 412 when the resource changed. */
  ifMatch?: string | undefined;
  signal?: AbortSignal | undefined;
}

/** An empty response gives `{}`, then `schema` parses it. */
export async function googleJson<T>(
  service: GoogleService,
  schema: z.ZodType<T>,
  request: GoogleJsonRequest,
): Promise<T> {
  const { method = "GET", url, accessToken, payload, retry = "none", ifMatch, signal } = request;

  return authedJson(
    schema,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(ifMatch !== undefined ? { "If-Match": ifMatch } : {}),
      },
    },
    {
      url,
      method,
      body: method === "GET" || method === "DELETE" ? undefined : (payload ?? {}),
      ...(signal !== undefined ? { signal } : {}),
    },
    { provider: service, urlLabel: url, retry },
  );
}
