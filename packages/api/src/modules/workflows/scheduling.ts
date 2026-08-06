import { parseIanaTimezone, type IanaTimezone, type WorkflowTrigger } from "@alfred/contracts";
import { CronExpressionParser } from "cron-parser";
import { isValidTimezone } from "../briefing/preferences";
import { resolveTimezone } from "../settings";

/**
 * Workflow scheduling helpers (ADR-0027).
 *
 * `cron-parser` runs at *write time* — when a workflow row mutates and
 * after each tick fire — so the per-minute `workflows.tick` is a partial
 * index lookup on `next_run_at`, not an O(n) cron parse. This module is
 * the only place that knows the parser exists.
 *
 * Tz resolution chain is shared with ADR-0025's morning briefing:
 *
 *   1. `trigger.timezone` on the workflow row, if set + valid IANA tz.
 *   2. The shared user timezone resolver (`timezone`, then `briefing.timezone`).
 *   3. UTC fallback.
 */

export const DEFAULT_WORKFLOW_TIMEZONE = parseIanaTimezone("UTC");

export function validateCronTrigger(
  trigger: WorkflowTrigger,
  opts: { timezone?: IanaTimezone } = {},
): { ok: true } | { ok: false; message: string } {
  if (trigger.kind !== "cron") return { ok: true };
  if (trigger.timezone && !isValidTimezone(trigger.timezone)) {
    return { ok: false, message: `invalid timezone '${trigger.timezone}'` };
  }
  const timezone = trigger.timezone
    ? parseIanaTimezone(trigger.timezone)
    : (opts.timezone ?? DEFAULT_WORKFLOW_TIMEZONE);
  try {
    CronExpressionParser.parse(trigger.schedule, {
      currentDate: new Date(),
      tz: timezone,
    }).next();
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "invalid cron expression",
    };
  }
}

/**
 * Resolve the timezone used to compute `next_run_at` for a cron workflow.
 *
 * The trigger-level override wins because users sometimes want a single
 * "America/New_York" workflow even after they fly to Tokyo and update
 * their preference. The pref-level fallback covers the common case where
 * the user has one canonical tz and every workflow inherits it.
 */
export async function resolveWorkflowTimezone(
  userId: string,
  trigger: WorkflowTrigger,
): Promise<IanaTimezone> {
  if (trigger.kind === "cron" && trigger.timezone && isValidTimezone(trigger.timezone)) {
    return parseIanaTimezone(trigger.timezone);
  }
  return resolveTimezone(userId);
}

/**
 * Compute the next firing instant for a cron trigger relative to `from`
 * (defaulting to now). Returns `null` for non-cron triggers and for
 * malformed expressions — the caller treats null as "this workflow does
 * not contribute to the tick index" rather than throwing, so a single
 * bad row can't crash the dispatcher.
 *
 * `cron-parser` interprets the schedule in `timezone`, so `0 7 * * *` +
 * `America/New_York` returns 7am EST, not 7am UTC.
 */
export function computeNextRunAt(
  trigger: WorkflowTrigger,
  opts: { from?: Date; timezone: IanaTimezone },
): Date | null {
  if (trigger.kind !== "cron") return null;
  try {
    const expr = CronExpressionParser.parse(trigger.schedule, {
      currentDate: opts.from ?? new Date(),
      tz: opts.timezone,
    });
    return expr.next().toDate();
  } catch {
    return null;
  }
}

/** Deterministic approval copy derived from the trigger it describes. */
export function workflowScheduleSummary(trigger: WorkflowTrigger): string {
  switch (trigger.kind) {
    case "cron":
      return describeCronSchedule(trigger.schedule, trigger.timezone);
    case "event":
      return "For every Gmail delivery; Alfred evaluates semantic conditions inside the run";
    case "manual":
      return "Manual runs only";
    case "on_signal":
      return `On signal: ${trigger.name}`;
  }
}

function describeCronSchedule(schedule: string, timezone?: string): string {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = schedule.trim().split(/\s+/);
  const numericMinute = Number(minute);
  const numericHour = Number(hour);
  const zone = timezone ? ` (${timezone})` : "";
  if (
    Number.isInteger(numericMinute) &&
    Number.isInteger(numericHour) &&
    dayOfMonth === "*" &&
    month === "*"
  ) {
    const time = friendlyClock(numericHour, numericMinute);
    if (dayOfWeek === "1-5") return `Every weekday at ${time}${zone}`;
    if (dayOfWeek === "*") return `Every day at ${time}${zone}`;
    const weekday = dayOfWeek === undefined ? undefined : friendlyWeekdays(dayOfWeek);
    if (weekday) return `Every ${weekday} at ${time}${zone}`;
  }
  return `Schedule ${schedule}${zone}`;
}

function friendlyClock(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${period}`;
}

function friendlyWeekdays(value: string): string | null {
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const indexes = value.split(",").map(Number);
  if (indexes.some((index) => !Number.isInteger(index) || index < 0 || index > 6)) return null;
  return indexes.map((index) => names[index]).join(", ");
}
