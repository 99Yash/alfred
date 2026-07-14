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
 * Deliberately date-only so the stable system/tool prefix can be reused across
 * chat runs. Exact run time belongs in ephemeral model context via
 * {@link formatRuntimeTimeGrounding}, never in this cached string.
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

/** Exact run-start anchor for hour-scale relative-time reasoning. */
export function formatRuntimeTimeGrounding(timezone: string, now: Date): string {
  const localTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(now);
  const local = `${localDateInTimezone(timezone, now)}T${localTime}`;
  return `<runtime_context>Current time: ${now.toISOString()} (${local} in ${timezone}).</runtime_context>`;
}
