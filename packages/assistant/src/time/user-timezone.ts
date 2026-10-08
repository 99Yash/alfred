import { assertIanaTimezone, isIanaTimezone, type IanaTimezone } from "@alfred/contracts";

/** Pure zone helpers: no preference read, no database. The preference resolver is `settings.resolveTimezone`. */

/**
 * Checked at load, not cast. `Intl.supportedValuesOf` omits `"UTC"`, which once
 * broke every briefing `gather`. A regression now fails at boot.
 */
export const DEFAULT_USER_TIMEZONE: IanaTimezone = ((): IanaTimezone => {
  const value = "UTC";
  assertIanaTimezone(value);

  return value;
})();

/**
 * Zone precedence, canonical key first (ADR-0082). `settings.resolveTimezone`
 * and `resolveBriefingPreferences` both map this tuple, so the two zones
 * cannot diverge (#229). `briefing.timezone` is the legacy fallback.
 */
export const TIMEZONE_PREFERENCE_KEYS = ["timezone", "briefing.timezone"] as const;

export function firstValidTimezone(values: readonly unknown[]): IanaTimezone {
  for (const value of values) {
    if (isIanaTimezone(value)) return value;
  }

  return DEFAULT_USER_TIMEZONE;
}

/** Domain name for {@link isIanaTimezone}, which also accepts `"UTC"` and `"Etc/UTC"`. */
export const isValidTimezone = isIanaTimezone;
