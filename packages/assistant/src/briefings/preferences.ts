import { type IanaTimezone } from "@alfred/contracts";
import {
  briefingHourSchema,
  DEFAULT_BRIEFING_DELIVERY_HOUR,
  DEFAULT_BRIEFING_EVENING_HOUR,
  DEFAULT_BRIEFING_TIMEZONE,
} from "@alfred/contracts/briefing-constants";
import { getPreference } from "@alfred/assistant/settings";
import {
  firstValidTimezone,
  isValidTimezone,
  TIMEZONE_PREFERENCE_KEYS,
} from "@alfred/assistant/time";

/**
 * Briefing hours and zone live in `user_preferences`. Zone order comes from
 * {@link TIMEZONE_PREFERENCE_KEYS} via {@link firstValidTimezone}, the same path as
 * `settings.resolveTimezone`, so delivery and date reasoning agree (#229). Then UTC.
 */

export { DEFAULT_BRIEFING_DELIVERY_HOUR, DEFAULT_BRIEFING_EVENING_HOUR, DEFAULT_BRIEFING_TIMEZONE };

export interface BriefingPreferences {
  timezone: IanaTimezone;
  /** Morning hour (0-23, in `timezone`). Old name kept. */
  deliveryHour: number;
  /** 0-23, in `timezone`. */
  eveningHour: number;
  /** At least one value came from the user's row. */
  hasUserOverride: boolean;
}

interface BriefingPreferenceValues {
  /** In `TIMEZONE_PREFERENCE_KEYS` order. */
  timezoneValues: readonly unknown[];
  deliveryHour: unknown;
  eveningHour: unknown;
}

export async function resolveBriefingPreferences(userId: string): Promise<BriefingPreferences> {
  // Every `getPreference` call starts before the first await, so this is one round-trip.
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
  const result = briefingHourSchema.safeParse(value);

  return result.success ? result.data : null;
}
