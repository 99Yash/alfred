import type { IanaTimezone } from "@alfred/contracts";
import { formatDay, inZone } from "../timezone";

/**
 * One-line date grounding for a system prompt, e.g.
 * "Wednesday, 10 June 2026 (2026-06-10), timezone Asia/Kolkata".
 *
 * For a single-turn or non-parking agent prompt — the morning brief, a
 * sub-agent, an eval — whose cached system prefix never has to re-stamp "now".
 * The chat path does NOT use this: a chat run can park (awaiting a sub-agent or
 * an approval) and resume across midnight, so a date pinned into its cached
 * prefix would go stale. Chat grounds date AND time from the single
 * re-anchorable {@link formatRuntimeTimeGrounding} line instead (#410).
 */
export function formatDateGrounding(timezone: IanaTimezone, now: Date = new Date()): string {
  const today = inZone(timezone).day(now);
  return `${formatDay(today, "long")} (${today}), timezone ${timezone}`;
}

/**
 * The chat run's single source of "now" — the current date AND exact time, in
 * one ephemeral transcript line. It carries the weekday and human date (for
 * "next Tuesday"), the local ISO instant (for machine dates), the timezone, and
 * the absolute UTC instant (for RFC3339 windows the model hand-computes). This
 * line rides the model transcript, never the cached system prefix, so — unlike
 * a date pinned into that prefix — it may re-stamp when a parked run resumes
 * (see {@link resolveRuntimeGroundingAnchor}). The chat workflow clears the
 * persisted anchor whenever it parks, so a wake across midnight gets the right
 * day without disturbing a long, contiguous tool loop.
 */
export function formatRuntimeTimeGrounding(timezone: IanaTimezone, now: Date): string {
  const { localDate, localTime } = inZone(timezone).clock(now);
  const localIso = `${localDate}T${localTime}`;
  return `<runtime_context>Current date and time: ${formatDay(localDate, "long")}, ${localTime} (${localIso} in ${timezone}; ${now.toISOString()} UTC).</runtime_context>`;
}

/**
 * Choose the instant the ephemeral "now" line ({@link
 * formatRuntimeTimeGrounding}) anchors to for one chat turn.
 *
 * That line rides the model transcript, never the cached system prefix, so it
 * may change between turns. It's still anchored rather than live: a contiguous
 * execution slice reuses `previous` for however long it runs, so the growing
 * tool-result tail stays cacheable. Every actual park clears the persisted
 * anchor at the lifecycle seam; the resumed invocation therefore arrives with
 * no `previous` and anchors to wake-time. Duration is deliberately irrelevant:
 * a three-minute midnight park refreshes, while a ten-minute uninterrupted
 * research loop does not (#410).
 */
export function resolveRuntimeGroundingAnchor(
  previous: Date | undefined,
  now: Date = new Date(),
): Date {
  // A future checkpoint can only come from clock skew or corrupt legacy state;
  // it is not a valid contiguous-slice anchor.
  return previous && previous.getTime() <= now.getTime() ? previous : now;
}
