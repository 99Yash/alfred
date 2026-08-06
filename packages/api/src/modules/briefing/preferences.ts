import { isIanaTimezone, type IanaTimezone } from "@alfred/contracts";
import {
  DEFAULT_BRIEFING_DELIVERY_HOUR,
  DEFAULT_BRIEFING_EVENING_HOUR,
  DEFAULT_BRIEFING_TIMEZONE,
} from "@alfred/contracts/briefing-constants";
import { getPreference } from "../settings";
import { firstValidTimezone, TIMEZONE_PREFERENCE_KEYS } from "../timezone";

/**
 * Briefing time-of-day preferences live under `user_preferences` keys
 * (called out canonically in `packages/db/src/schema/memory.ts`). The
 * defaults are shared cross-boundary in `@alfred/contracts/briefing-constants`.
 *
 * Timezone resolution (#229): the canonical zone key is `timezone` — it grounds
 * chat/boss date reasoning AND briefing delivery, so the two can never diverge.
 * The legacy `briefing.timezone` key is read as a fallback for rows written
 * before the unification. The key-set and its canonical order live once in
 * {@link TIMEZONE_PREFERENCE_KEYS}; this maps that const through the same
 * {@link firstValidTimezone} primitive `settings.resolveTimezone` uses, rather
 * than restating either. After the const (`timezone`, then `briefing.timezone`)
 * comes `DEFAULT_USER_TIMEZONE` (UTC) — so a user with no pref row still gets
 * daily emails at a predictable time.
 *
 * The browser's `Intl.DateTimeFormat().resolvedOptions().timeZone` is captured
 * at onboarding and persisted to `timezone`, so a user who never opens settings
 * no longer silently defaults to UTC.
 */

export { DEFAULT_BRIEFING_DELIVERY_HOUR, DEFAULT_BRIEFING_EVENING_HOUR, DEFAULT_BRIEFING_TIMEZONE };

export interface BriefingPreferences {
  timezone: IanaTimezone;
  /** Morning delivery hour (0-23, in `timezone`). Backwards-compatible name. */
  deliveryHour: number;
  /** Evening delivery hour (0-23, in `timezone`). */
  eveningHour: number;
  /** True when at least one of the values came from the pref row, not the fallback. */
  hasUserOverride: boolean;
}

interface BriefingPreferenceValues {
  /** Zone values in `TIMEZONE_PREFERENCE_KEYS` order (canonical-first). */
  timezoneValues: readonly unknown[];
  deliveryHour: unknown;
  eveningHour: unknown;
}

export async function resolveBriefingPreferences(userId: string): Promise<BriefingPreferences> {
  // #229: the zone keys and their canonical order come from
  // `TIMEZONE_PREFERENCE_KEYS` (canonical `timezone`, then legacy
  // `briefing.timezone`) — the same const `settings.resolveTimezone` maps, so
  // delivery time and date reasoning never diverge. All four `getPreference`
  // calls fire synchronously before the first `await` (the `.map` and the two
  // sibling calls execute eagerly), so this stays a single round-trip.
  const [tzRows, hourRow, eveRow] = await Promise.all([
    Promise.all(TIMEZONE_PREFERENCE_KEYS.map((key) => getPreference(userId, key))),
    getPreference(userId, "briefing.delivery_hour"),
    getPreference(userId, "briefing.evening_hour"),
  ]);

  return resolveBriefingPreferenceValues({
    timezoneValues: tzRows.map((row) => row?.value),
    deliveryHour: hourRow?.value,
    eveningHour: eveRow?.value,
  });
}

export function resolveBriefingPreferenceValues(
  values: BriefingPreferenceValues,
): BriefingPreferences {
  const timezone = firstValidTimezone(values.timezoneValues);
  const deliveryHour = parseDeliveryHour(values.deliveryHour) ?? DEFAULT_BRIEFING_DELIVERY_HOUR;
  const eveningHour = parseDeliveryHour(values.eveningHour) ?? DEFAULT_BRIEFING_EVENING_HOUR;
  const hasUserOverride =
    values.timezoneValues.some((value) => isValidTimezone(value)) ||
    parseDeliveryHour(values.deliveryHour) !== null ||
    parseDeliveryHour(values.eveningHour) !== null;

  return { timezone, deliveryHour, eveningHour, hasUserOverride };
}

function parseDeliveryHour(value: unknown): number | null {
  // Tolerate stringified ints — Replicache mutators may serialize.
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n)) return null;
  if (n < 0 || n > 23) return null;
  return n;
}

/**
 * Local alias of the canonical timezone validator. The implementation lives
 * once in `@alfred/contracts` ({@link isIanaTimezone}) — memoized and
 * alias-aware (accepts "UTC"/"Etc/UTC", which a bare `Intl.DateTimeFormat`
 * trial passes but `supportedValuesOf` alone would reject). Kept under this
 * name so the briefing/workflow call sites read in domain terms.
 */
export const isValidTimezone = isIanaTimezone;
