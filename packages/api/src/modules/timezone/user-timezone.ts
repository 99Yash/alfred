import { assertIanaTimezone, isIanaTimezone, type IanaTimezone } from "@alfred/contracts";

/**
 * Pure zone helpers — a default zone and the canonical-first precedence
 * primitive. This file reads no preference and no database; it imports only
 * `@alfred/contracts`, so the `time` (`timezone`) module stays deterministic and
 * testable without a database. The user-preference-reading resolver lives in
 * `settings.resolveTimezone`.
 */

/**
 * Validated at module load rather than cast. `"UTC"` is a real alias that
 * `Intl.DateTimeFormat` accepts but `Intl.supportedValuesOf` omits — the exact
 * gap `isSupportedTimezone` closes, and the one that once threw in every
 * briefing `gather`. If that ever regresses, it fails here at boot instead of
 * per request.
 */
export const DEFAULT_USER_TIMEZONE: IanaTimezone = ((): IanaTimezone => {
  const value = "UTC";
  assertIanaTimezone(value);
  return value;
})();

export function firstValidTimezone(values: readonly unknown[]): IanaTimezone {
  for (const value of values) {
    if (isIanaTimezone(value)) return value;
  }
  return DEFAULT_USER_TIMEZONE;
}
