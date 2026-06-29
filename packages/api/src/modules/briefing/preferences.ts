import {
  DEFAULT_BRIEFING_DELIVERY_HOUR,
  DEFAULT_BRIEFING_EVENING_HOUR,
  DEFAULT_BRIEFING_TIMEZONE,
} from "@alfred/contracts/briefing-constants";
import { getPreference } from "../memory/preferences";

/**
 * Briefing time-of-day preferences live under `user_preferences` keys
 * (called out canonically in `packages/db/src/schema/memory.ts`). The
 * defaults are shared cross-boundary in `@alfred/contracts/briefing-constants`.
 *
 * Timezone resolution (#229): the canonical zone key is `timezone` — it grounds
 * chat/boss date reasoning AND briefing delivery, so the two can never diverge.
 * The legacy `briefing.timezone` key is read as a fallback for rows written
 * before the unification. Precedence matches `resolveUserTimezone`:
 *
 *   1. `timezone` (canonical — what the settings picker + onboarding now write).
 *   2. `briefing.timezone` (legacy fallback).
 *   3. The shared v1 default (UTC) — explicit so a user with no pref row still
 *      gets daily emails at a predictable time.
 *
 * The browser's `Intl.DateTimeFormat().resolvedOptions().timeZone` is captured
 * at onboarding and persisted to `timezone`, so a user who never opens settings
 * no longer silently defaults to UTC.
 */

export { DEFAULT_BRIEFING_DELIVERY_HOUR, DEFAULT_BRIEFING_EVENING_HOUR, DEFAULT_BRIEFING_TIMEZONE };

export interface BriefingPreferences {
  timezone: string;
  /** Morning delivery hour (0-23, in `timezone`). Backwards-compatible name. */
  deliveryHour: number;
  /** Evening delivery hour (0-23, in `timezone`). */
  eveningHour: number;
  /** True when at least one of the values came from the pref row, not the fallback. */
  hasUserOverride: boolean;
}

export async function resolveBriefingPreferences(userId: string): Promise<BriefingPreferences> {
  const [generalTzRow, briefingTzRow, hourRow, eveRow] = await Promise.all([
    // #229: `timezone` is the canonical zone (also grounds chat/boss); the
    // briefing picker now writes it. `briefing.timezone` stays a fallback for
    // rows written before the unification — same precedence as
    // `resolveUserTimezone`, so delivery time and date reasoning never diverge.
    getPreference(userId, "timezone"),
    getPreference(userId, "briefing.timezone"),
    getPreference(userId, "briefing.delivery_hour"),
    getPreference(userId, "briefing.evening_hour"),
  ]);

  const canonicalTz = parseTimezone(generalTzRow?.value);
  const legacyTz = parseTimezone(briefingTzRow?.value);
  const timezone = canonicalTz ?? legacyTz ?? DEFAULT_BRIEFING_TIMEZONE;
  const deliveryHour = parseDeliveryHour(hourRow?.value) ?? DEFAULT_BRIEFING_DELIVERY_HOUR;
  const eveningHour = parseDeliveryHour(eveRow?.value) ?? DEFAULT_BRIEFING_EVENING_HOUR;
  const hasUserOverride =
    canonicalTz !== null ||
    legacyTz !== null ||
    (hourRow !== null && parseDeliveryHour(hourRow.value) !== null) ||
    (eveRow !== null && parseDeliveryHour(eveRow.value) !== null);

  return { timezone, deliveryHour, eveningHour, hasUserOverride };
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
