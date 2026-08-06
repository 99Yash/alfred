import { type IanaTimezone } from "@alfred/contracts";

import { firstValidTimezone, TIMEZONE_PREFERENCE_KEYS } from "../timezone";
import { getPreference } from "./preferences";

/**
 * The user's operational zone, from their preferences.
 *
 * ADR-0082 (canonical timezone key): the resolved zone follows the canonical-
 * first precedence owned once by `TIMEZONE_PREFERENCE_KEYS` (canonical
 * `timezone`, then legacy `briefing.timezone`), then `DEFAULT_USER_TIMEZONE`
 * (UTC) — encoded by the shared `firstValidTimezone`.
 * `briefing.resolveBriefingPreferences` maps the same const through that same
 * primitive, so a user's date-reasoning zone and their briefing-delivery zone
 * can never diverge.
 *
 * One uncached `SELECT` per key, so this is not free — callers on a per-item hot
 * path (triage classifies one email per step) must resolve it only when the
 * value is actually needed, rather than eagerly per item.
 */
export async function resolveTimezone(userId: string): Promise<IanaTimezone> {
  const rows = await Promise.all(TIMEZONE_PREFERENCE_KEYS.map((key) => getPreference(userId, key)));
  return firstValidTimezone(rows.map((row) => row?.value));
}
