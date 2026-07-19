import { httpErrorFromResponse } from "@alfred/contracts";

/**
 * Shared authenticated-JSON transport for the Google REST clients
 * (calendar, gmail, drive, docs, sheets, slides).
 *
 * Every Google module hits the same wire contract: bearer-token auth, a JSON
 * `Accept`, the shared {@link GOOGLE_FETCH_TIMEOUT_MS} timeout, and non-OK →
 * {@link httpErrorFromResponse}. This is the one place that mechanism lives so
 * a change (retry, timeout, refresh) is made once. Each module keeps its own
 * thin `getJson`/`postJson`/`sendJson` wrapper that binds its service tag, so
 * call sites and per-module vocabulary are unchanged. The raw-text download
 * path in `drive.ts` (`getText`) can't route through `googleJson` — it needs
 * byte-truncation and no JSON `Accept` — but it imports this same timeout so
 * the number stays single-sourced.
 */

/** Shared request timeout for every Google API call (JSON transport + drive text downloads). */
export const GOOGLE_FETCH_TIMEOUT_MS = 30_000;

/** Provider tag threaded into {@link httpErrorFromResponse} for telemetry. */
export type GoogleService = "calendar" | "gmail" | "drive" | "docs" | "sheets" | "slides";

/**
 * Issue an authenticated Google API request and parse the JSON response.
 *
 * `GET` sends no body; other methods JSON-encode `payload` (defaulting to `{}`).
 * A `204`/empty body resolves to `{}`. Non-OK responses throw an `HttpError`
 * carrying a bounded, secret-redacted slice of the body.
 */
export async function googleJson(
  service: GoogleService,
  method: "GET" | "POST" | "PUT",
  url: string,
  accessToken: string,
  payload?: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
  };
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(payload ?? {});
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    throw await httpErrorFromResponse(service, res, { url, method });
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}
