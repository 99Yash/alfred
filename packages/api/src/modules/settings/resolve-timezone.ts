import { type IanaTimezone } from "@alfred/contracts";

import { firstValidTimezone } from "../timezone";
import { getPreference } from "./preferences";

/**
 * The user's operational zone, from their preferences.
 *
 * ADR-0082 (canonical timezone key): the resolved zone is the canonical
 * `timezone` preference, then the legacy `briefing.timezone` fallback, then
 * `DEFAULT_USER_TIMEZONE` (UTC) — the canonical-first precedence encoded by the
 * shared `firstValidTimezone`. `briefing.resolveBriefingPreferences` reads the
 * same two keys through that same primitive, so a user's date-reasoning zone and
 * their briefing-delivery zone can never diverge.
 *
 * Two uncached `SELECT`s, so this is not free — callers on a per-item hot path
 * (triage classifies one email per step) must resolve it only when the value is
 * actually needed, rather than eagerly per item.
 */
export async function resolveTimezone(userId: string): Promise<IanaTimezone> {
  const [general, briefing] = await Promise.all([
    getPreference(userId, "timezone"),
    getPreference(userId, "briefing.timezone"),
  ]);
  return firstValidTimezone([general?.value, briefing?.value]);
}
