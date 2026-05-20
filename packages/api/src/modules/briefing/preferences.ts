import { getPreference } from "../memory/preferences";

/**
 * Briefing time-of-day preferences live under two `user_preferences`
 * keys (called out canonically in `packages/db/src/schema/memory.ts`):
 *
 *   `briefing.timezone`       string IANA tz, e.g. "America/New_York"
 *   `briefing.delivery_hour`  integer 0–23 in that tz
 *
 * The fallback chain is conservative on purpose:
 *
 *   1. The pref row itself, if set to a valid value.
 *   2. UTC + 7am — the documented v1 default; explicit so a user with
 *      no pref row still gets a daily email at a predictable time.
 *
 * "Captured-at-signup tz" was on the table as an intermediate fallback
 * but the OTP flow doesn't surface the browser's `Intl.DateTimeFormat`
 * to the server — wiring that up is m12 territory (settings page).
 * Until then, the user can set `briefing.timezone` explicitly via the
 * memory mutator (Replicache) or we can read it from a future signup
 * step.
 */

export const DEFAULT_BRIEFING_TIMEZONE = "UTC";
export const DEFAULT_BRIEFING_DELIVERY_HOUR = 7;

export interface BriefingPreferences {
  timezone: string;
  deliveryHour: number;
  /** True when at least one of the values came from the pref row, not the fallback. */
  hasUserOverride: boolean;
}

export async function resolveBriefingPreferences(userId: string): Promise<BriefingPreferences> {
  const [tzRow, hourRow] = await Promise.all([
    getPreference(userId, "briefing.timezone"),
    getPreference(userId, "briefing.delivery_hour"),
  ]);

  const timezone = parseTimezone(tzRow?.value) ?? DEFAULT_BRIEFING_TIMEZONE;
  const deliveryHour = parseDeliveryHour(hourRow?.value) ?? DEFAULT_BRIEFING_DELIVERY_HOUR;
  const hasUserOverride =
    (tzRow !== null && parseTimezone(tzRow.value) !== null) ||
    (hourRow !== null && parseDeliveryHour(hourRow.value) !== null);

  return { timezone, deliveryHour, hasUserOverride };
}

function parseTimezone(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  if (!isValidTimezone(value)) return null;
  return value;
}

function parseDeliveryHour(value: unknown): number | null {
  // Tolerate stringified ints — Replicache mutators may serialize.
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n)) return null;
  if (n < 0 || n > 23) return null;
  return n;
}

/**
 * IANA tz validation by trial — `Intl.DateTimeFormat` throws RangeError
 * on unknown zones. `Intl.supportedValuesOf('timeZone')` is V8-modern
 * but not universal; the throw-on-bad path works everywhere.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Local-date string (YYYY-MM-DD) for `now` rendered in `timezone`. Used
 * as the day-segment of the briefing idempotency key, so the same
 * machine-day in a user's tz never sends twice.
 *
 * `sv-SE` locale formats dates as `YYYY-MM-DD` natively, which is the
 * shortest path to a stable ISO-style date string in any timezone.
 */
export function localDateInTimezone(timezone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** 0–23 hour-of-day in `timezone` for `now`. */
export function localHourInTimezone(timezone: string, now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  const hourStr = parts.find((p) => p.type === "hour")?.value;
  if (!hourStr) {
    throw new Error(`[briefing.preferences] could not extract hour from tz=${timezone}`);
  }
  // `hour: 'numeric'` with `hour12: false` returns "0".."23"; some
  // engines emit "24" at midnight. Normalize.
  const n = Number(hourStr);
  return n === 24 ? 0 : n;
}
