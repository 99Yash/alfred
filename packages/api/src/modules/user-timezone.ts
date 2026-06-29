import { isValidTimezone } from "./briefing/preferences";
import { getPreference } from "./memory/preferences";

export const DEFAULT_USER_TIMEZONE = "UTC";

/**
 * Pick the first valid timezone in priority order, falling back to UTC. Kept
 * pure so the preference-key precedence has a cheap regression test.
 */
export function firstValidTimezone(values: readonly unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && isValidTimezone(value)) return value;
  }
  return DEFAULT_USER_TIMEZONE;
}

/**
 * Resolve the user's general operational timezone. `timezone` is the canonical
 * key — written by the settings picker and onboarding capture (#229). The legacy
 * `briefing.timezone` key is read as a fallback so tools do not silently answer
 * in UTC for users whose only stored zone predates the unification.
 */
export async function resolveUserTimezone(userId: string): Promise<string> {
  const [general, briefing] = await Promise.all([
    getPreference(userId, "timezone"),
    getPreference(userId, "briefing.timezone"),
  ]);
  return firstValidTimezone([general?.value, briefing?.value]);
}
