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

/**
 * ADR-0082 canonical-first zone precedence: the key-set and its order in one
 * place. Both preference-reading zone resolvers — `settings.resolveTimezone`
 * and `briefing.resolveBriefingPreferences` — build their {@link
 * firstValidTimezone} input by mapping this tuple in order, so a user's
 * date-reasoning zone and their briefing-delivery zone can never diverge (the
 * #229 guarantee). The canonical `timezone` key wins; the legacy
 * `briefing.timezone` is the fallback for rows written before the unification.
 */
export const TIMEZONE_PREFERENCE_KEYS = ["timezone", "briefing.timezone"] as const;

export function firstValidTimezone(values: readonly unknown[]): IanaTimezone {
  for (const value of values) {
    if (isIanaTimezone(value)) return value;
  }
  return DEFAULT_USER_TIMEZONE;
}
