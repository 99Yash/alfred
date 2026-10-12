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
  method?: "GET" | "POST" | "PUT" | undefined;
  url: string;
  accessToken: string;
  /** A non-GET sends `payload ?? {}`. */
  payload?: unknown;
  /** Default `"none"`. */
  retry?: RetryPolicy | "none" | undefined;
  signal?: AbortSignal | undefined;
}

/** An empty response gives `{}`, then `schema` parses it. */
export async function googleJson<T>(
  service: GoogleService,
  schema: z.ZodType<T>,
  request: GoogleJsonRequest,
): Promise<T> {
  const { method = "GET", url, accessToken, payload, retry = "none", signal } = request;

  return authedJson(
    schema,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
    {
      url,
      method,
      body: method === "GET" ? undefined : (payload ?? {}),
      ...(signal !== undefined ? { signal } : {}),
    },
    { provider: service, urlLabel: url, retry },
  );
}
