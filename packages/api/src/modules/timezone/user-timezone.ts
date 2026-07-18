import { isValidTimezone } from "../briefing/preferences";
import { getPreference } from "../memory/preferences";

export const DEFAULT_USER_TIMEZONE = "UTC";

export function firstValidTimezone(values: readonly unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && isValidTimezone(value)) return value;
  }
  return DEFAULT_USER_TIMEZONE;
}

export async function resolveUserTimezone(userId: string): Promise<string> {
  const [general, briefing] = await Promise.all([
    getPreference(userId, "timezone"),
    getPreference(userId, "briefing.timezone"),
  ]);
  return firstValidTimezone([general?.value, briefing?.value]);
}
