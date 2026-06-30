/**
 * Cross-boundary briefing constants. Keep values here only when the server
 * (`@alfred/api`) and client (`apps/web`) must agree — `@alfred/api` is
 * server-only so the web bundle can't import it, and `@alfred/contracts` is
 * the dependency-free package both sides can share.
 *
 * Briefing time-of-day preferences live under `user_preferences` keys
 * (canonical in `packages/db/src/schema/memory.ts`):
 *
 *   `timezone`                canonical IANA tz, e.g. "America/New_York"
 *                             (`briefing.timezone` is a legacy read fallback)
 *   `briefing.delivery_hour`  integer 0–23 in that tz — morning slot
 *   `briefing.evening_hour`   integer 0–23 in that tz — evening slot
 *
 * These are the documented v1 fallbacks when no pref row is set, so a user
 * with no preferences still gets daily emails at predictable times.
 */

/** Default IANA timezone when neither `timezone` nor the legacy fallback is set. */
export const DEFAULT_BRIEFING_TIMEZONE = "UTC";

/** Default morning delivery hour (0–23, in the resolved timezone). */
export const DEFAULT_BRIEFING_DELIVERY_HOUR = 7;

/** Default evening delivery hour (0–23, in the resolved timezone). */
export const DEFAULT_BRIEFING_EVENING_HOUR = 18;
