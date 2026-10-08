import type { RestPassthroughProfile } from "../shared/rest-passthrough";
import type { GoogleService } from "./http";

/**
 * Read-only passthrough base URLs (ADR-0074), one per Google API version namespace.
 * Broader than the curated `API_BASE` constants, but a path cannot leave the namespace.
 * Gmail pins `/users/me`, so only the connected mailbox is readable.
 */
export const GOOGLE_PASSTHROUGH_BASE_URLS = {
  gmail: "https://gmail.googleapis.com/gmail/v1/users/me",
  calendar: "https://www.googleapis.com/calendar/v3",
  drive: "https://www.googleapis.com/drive/v3",
  docs: "https://docs.googleapis.com/v1",
  sheets: "https://sheets.googleapis.com/v4",
  slides: "https://slides.googleapis.com/v1",
} satisfies Record<GoogleService, string>;

/** Stays inside the integrations package. */
export function googlePassthroughProfile(
  service: GoogleService,
  token: string,
): RestPassthroughProfile {
  return {
    baseUrl: GOOGLE_PASSTHROUGH_BASE_URLS[service],
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  };
}
