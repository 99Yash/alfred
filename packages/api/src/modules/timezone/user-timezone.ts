import { assertIanaTimezone, isIanaTimezone, type IanaTimezone } from "@alfred/contracts";
import { getPreference } from "../memory/preferences";

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

/**
 * The user's operational zone, from their preferences.
 *
 * Two uncached `SELECT`s, so this is not free — callers on a per-item hot path
 * (triage classifies one email per step) must resolve it only when the value is
 * actually needed, rather than eagerly per item.
 */
export async function resolveUserTimezone(userId: string): Promise<IanaTimezone> {
  const [general, briefing] = await Promise.all([
    getPreference(userId, "timezone"),
    getPreference(userId, "briefing.timezone"),
  ]);
  return firstValidTimezone([general?.value, briefing?.value]);
}
