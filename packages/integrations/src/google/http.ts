import { authedJson } from "../shared/authed-json";

/**
 * Shared authenticated-JSON transport for the Google REST clients
 * (calendar, gmail, drive, docs, sheets, slides).
 *
 * Every Google module hits the same wire contract: bearer-token auth, a JSON
 * `Accept`, and non-OK → `HttpError`. That is exactly {@link authedJson}, so
 * this is now a thin service-tagging wrapper over the shared layer rather than a
 * fourth hand-rolled transport core — a change to the mechanism (retry, timeout,
 * refresh) is made once, in `authedFetch`/`authedJson`. Each module keeps its own
 * `getJson`/`postJson`/`sendJson` wrapper that binds its service tag, so call
 * sites and per-module vocabulary are unchanged. The raw-text download path in
 * `drive.ts` (`getText`) can't route through here — it needs byte-truncation and
 * no JSON `Accept` — but it shares the one `INTEGRATION_FETCH_TIMEOUT_MS`.
 */

/** Provider tag threaded into the thrown `HttpError` for telemetry. */
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
  return authedJson(
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
    // Non-GET always carries a JSON body (defaulting to `{}`); GET carries none,
    // so the transport adds `Content-Type` only for the former.
    { url, method, body: method === "GET" ? undefined : (payload ?? {}) },
    { provider: service, urlLabel: url },
  );
}
