import { z } from "zod";
import { authedJson } from "../shared/authed-json";
import type { RetryPolicy } from "../shared/retry";

/**
 * {@link authedJson} tagged with a Google service. Drive's raw-text download cannot use
 * it (it truncates bytes and sends no JSON `Accept`).
 */

export type GoogleService = "calendar" | "gmail" | "drive" | "docs" | "sheets" | "slides";

/** For calls that only need success. Passing it says "response unchecked" out loud. */
export const uncheckedResponse: z.ZodType<unknown> = z.unknown();

/** A non-GET sends `payload ?? {}`. An empty response gives `{}`. */
export async function googleJson(
  service: GoogleService,
  method: "GET" | "POST" | "PUT",
  url: string,
  accessToken: string,
  payload?: unknown,
  retry: RetryPolicy | "none" = "none",
  signal?: AbortSignal | undefined,
): Promise<unknown> {
  return authedJson(
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
