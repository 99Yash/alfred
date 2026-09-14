import type { IanaTimezone } from "@alfred/contracts";
import { formatDay, inZone } from "@alfred/assistant/time";

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
 * a date pinned into that prefix — it may re-stamp mid-run (see {@link
 * resolveRuntimeGroundingAnchor}).
 *
 * Re-stamping is not free: the line sits early in the transcript, ahead of the
 * whole tool-result tail, so a changed clock digit costs the prompt cache
 * everything after it. Measured in production: three approval parks seconds
 * apart pinned the cached prefix at 6,824 tokens for three consecutive calls
 * (`run_ilt4qehq3ul9`). That is why the anchor below re-stamps on a reading
 * that is actually WRONG, not on every discontinuity.
 */
export function formatRuntimeTimeGrounding(timezone: IanaTimezone, now: Date): string {
  const { localDate, localTime } = inZone(timezone).clock(now);
  const localIso = `${localDate}T${localTime}`;

  return `<runtime_context>Current date and time: ${formatDay(localDate, "long")}, ${localTime} (${localIso} in ${timezone}; ${now.toISOString()} UTC).</runtime_context>`;
}

/**
 * How long a park may last before the resumed run re-stamps "now".
 *
 * The threshold is the prompt cache's own lifetime, not a freshness taste. On a
 * Zero Data Retention org OpenAI holds the cached prefix `in_memory` for
 * roughly five idle minutes, so past this point a preserved anchor protects a
 * prefix that no longer exists — the re-stamp is free, and the reading it
 * refreshes is worth having. Under it, the tail is still cached and worth far
 * more than five minutes of clock precision, which `system.current_time` gives
 * the model on demand anyway. Every park observed in production so far lasted
 * under twenty seconds.
 */
export const RUNTIME_GROUNDING_PARK_GRACE_MS = 5 * 60_000;

/**
 * Choose the instant the ephemeral "now" line ({@link
 * formatRuntimeTimeGrounding}) anchors to for one chat turn.
 *
 * That line rides the model transcript, never the cached system prefix, so it
 * may change between turns. It is still anchored rather than live: a contiguous
 * execution slice reuses `previous` for however long it runs, so the growing
 * tool-result tail stays cacheable (#410).
 *
 * A park no longer re-stamps by itself. It used to: the seam cleared the
 * persisted anchor, so even a one-second approval arrived here with no
 * `previous` and wrote a new clock — which cost the cache the whole tail behind
 * the line. Two rules replace it, and each states the reading it protects:
 *
 * - **The calendar day here changed.** A stale day is the one error no later
 *   tool call repairs, because the model reads "Tuesday" and never doubts it.
 *   This covers the midnight park the clear-on-park rule was built for, and it
 *   also covers the case that rule never did — an uninterrupted tool loop that
 *   runs across midnight keeps yesterday's date today.
 * - **The park outlived the cache** ({@link RUNTIME_GROUNDING_PARK_GRACE_MS}).
 *   Decided at the wake seam, where the park's duration is known; a long park
 *   arrives here with `previous` already cleared.
 */
export function resolveRuntimeGroundingAnchor(
  previous: Date | undefined,
  timezone: IanaTimezone,
  now: Date = new Date(),
): Date {
  if (previous === undefined) return now;

  // A future checkpoint can only come from clock skew or corrupt legacy state;
  // it is not a valid contiguous-slice anchor.
  if (previous.getTime() > now.getTime()) return now;

  const here = inZone(timezone);

  return here.day(previous) === here.day(now) ? previous : now;
}
