import { localDateInTimezone } from "../briefing/preferences";
import { resolveUserTimezone } from "../user-timezone";

/**
 * The user's operational timezone — the same resolver `calendar.list_events`
 * and GitHub relative windows use. Grounding the agent's "today" with this
 * value keeps the date the model reasons about in lockstep with the date tools
 * actually query. Falls back to UTC.
 */
export { resolveUserTimezone };

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
