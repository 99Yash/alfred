import { isValidTimezone } from "./briefing/preferences";
import { getPreference } from "./memory/preferences";

/**
 * Resolve the user's general operational timezone from the `timezone`
 * preference. Falls back to UTC when unset or invalid.
 */
export async function resolveUserTimezone(userId: string): Promise<string> {
  const pref = await getPreference(userId, "timezone");
  if (pref && typeof pref.value === "string" && isValidTimezone(pref.value)) {
    return pref.value;
  }
  return "UTC";
}
