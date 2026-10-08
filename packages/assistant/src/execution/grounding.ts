import type { IanaTimezone } from "@alfred/contracts";
import { formatDay, inZone } from "@alfred/assistant/time";

/**
 * The date line for a prompt that never parks. Chat can park past midnight,
 * so it uses {@link formatRuntimeTimeGrounding} instead (#410).
 */
export function formatDateGrounding(timezone: IanaTimezone, now: Date = new Date()): string {
  const today = inZone(timezone).day(now);

  return `${formatDay(today, "long")} (${today}), timezone ${timezone}`;
}

/**
 * Chat's "now" line, in the transcript and not the system prefix.
 * It sits before the tool results, so each re-stamp loses the cache for everything after it.
 */
export function formatRuntimeTimeGrounding(timezone: IanaTimezone, now: Date): string {
  const { localDate, localTime } = inZone(timezone).clock(now);
  const localIso = `${localDate}T${localTime}`;

  return `<runtime_context>Current date and time: ${formatDay(localDate, "long")}, ${localTime} (${localIso} in ${timezone}; ${now.toISOString()} UTC).</runtime_context>`;
}

/**
 * A park longer than this re-stamps "now". It matches the provider's idle cache lifetime, so the
 * re-stamp costs nothing.
 */
export const RUNTIME_GROUNDING_PARK_GRACE_MS = 5 * 60_000;

/**
 * Keep `previous` so the tool-result tail stays cached (#410). Re-stamp only when the local day
 * changed,
 * since the model never doubts a stale weekday. A long park arrives with `previous` already
 * cleared.
 */
export function resolveRuntimeGroundingAnchor(
  previous: Date | undefined,
  timezone: IanaTimezone,
  now: Date = new Date(),
): Date {
  if (previous === undefined) return now;

  // A future anchor means clock skew or corrupt state.
  if (previous.getTime() > now.getTime()) return now;

  const here = inZone(timezone);

  return here.day(previous) === here.day(now) ? previous : now;
}
