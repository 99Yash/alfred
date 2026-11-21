import type { IanaTimezone } from "@alfred/contracts";
import { formatDay, inZone } from "@alfred/assistant/time";

/**
 * The date line for a prompt that never parks. Chat can park past midnight, so it gets the
 * time from saved time notes instead (ADR-0130 decision 7).
 */
export function formatDateGrounding(timezone: IanaTimezone, now: Date = new Date()): string {
  const today = inZone(timezone).day(now);

  return `${formatDay(today, "long")} (${today}), timezone ${timezone}`;
}
