import { type IanaTimezone } from "@alfred/contracts";

import { firstValidTimezone, TIMEZONE_PREFERENCE_KEYS } from "@alfred/assistant/time";
import { getPreference } from "./preferences";

/**
 * The user's zone: `timezone`, then legacy `briefing.timezone`, then UTC (ADR-0082).
 * Briefings use the same `firstValidTimezone`, so the two zones cannot diverge.
 * One uncached SELECT per key: on a per-item hot path, resolve it only when needed.
 */
export async function resolveTimezone(userId: string): Promise<IanaTimezone> {
  const rows = await Promise.all(TIMEZONE_PREFERENCE_KEYS.map((key) => getPreference(userId, key)));

  return firstValidTimezone(rows.map((row) => row?.value));
}
