import { isValidTimezone, localDateInTimezone } from "../briefing/preferences";
import { getPreference } from "../memory/preferences";

/**
 * The user's operational timezone — the same preference key
 * `calendar.list_events` resolves its relative windows against (the
 * `"timezone"` pref, NOT `"briefing.timezone"`). Grounding the agent's
 * "today" with this key keeps the date the model reasons about in lockstep
 * with the date the calendar tool actually queries. Falls back to UTC.
 */
export async function resolveUserTimezone(userId: string): Promise<string> {
  const pref = await getPreference(userId, "timezone");
  if (pref && typeof pref.value === "string" && isValidTimezone(pref.value)) {
    return pref.value;
  }
  return "UTC";
}

/**
 * One-line date grounding for an agent system prompt, e.g.
 * "Wednesday, 10 June 2026 (2026-06-10), timezone Asia/Kolkata".
 *
 * Deliberately date-only — no clock time. The system prompt carries an
 * `ephemeral` cache breakpoint (see `AlfredAgent`), so a value that changed
 * every minute would bust the system+tools prefix on every message. A
 * date is stable for the whole machine-day in the user's tz, so rapid
 * back-and-forth in a thread keeps hitting the cache. Intraday windows
 * (this morning/afternoon/tonight) are resolved server-side by the
 * calendar tool, so the model rarely needs the exact clock.
 */
export function formatDateGrounding(timezone: string, now: Date = new Date()): string {
  const human = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(now);
  const iso = localDateInTimezone(timezone, now);
  return `${human} (${iso}), timezone ${timezone}`;
}
