import type { RestPassthroughProfile } from "../shared/rest-passthrough";
import type { GoogleService } from "./http";

/**
 * Transport profiles for the general read-only passthrough tier (ADR-0074) over
 * the Google APIs. Each Google product is a distinct host + namespace, so the
 * pinned base URL is per-service — the model supplies only a namespace-relative
 * path and can never reach a different Google API or host.
 *
 * These are deliberately *broader* than the curated clients' private `API_BASE`
 * constants (which pin one deep collection, e.g. `.../v1/documents`): passthrough
 * pins the API *version namespace* so a raw read can reach any read endpoint
 * under it (`/documents/{id}`, `/files`, `/about`, `/calendars/{id}/events`, …)
 * without curation, while still being unable to leave the namespace.
 *
 * Gmail is pinned all the way to `/users/me`: the passthrough can only read the
 * connected user's own mailbox (labels, messages, threads, settings), never
 * another user id.
 */
export const GOOGLE_PASSTHROUGH_BASE_URLS: Record<GoogleService, string> = {
  gmail: "https://gmail.googleapis.com/gmail/v1/users/me",
  calendar: "https://www.googleapis.com/calendar/v3",
  drive: "https://www.googleapis.com/drive/v3",
  docs: "https://docs.googleapis.com/v1",
  sheets: "https://sheets.googleapis.com/v4",
  slides: "https://slides.googleapis.com/v1",
};

/**
 * Build the passthrough profile for a Google service: its pinned base URL +
 * bearer auth. The `Content-Type` is added by the transport only when a
 * read-via-POST body is sent, so it is deliberately absent here.
 */
export function googlePassthroughProfile(
  service: GoogleService,
  token: string,
): RestPassthroughProfile {
  return {
    baseUrl: GOOGLE_PASSTHROUGH_BASE_URLS[service],
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  };
}
