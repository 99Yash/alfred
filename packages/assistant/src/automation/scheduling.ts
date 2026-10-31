import {
  assertNever,
  eventTriggerPhrase,
  isIanaTimezone,
  isRawEventType,
  parseIanaTimezone,
  toMessage,
  type IanaTimezone,
  type WorkflowTrigger,
} from "@alfred/contracts";
import { CronExpressionParser } from "cron-parser";
import { settings } from "@alfred/assistant/settings";

/**
 * Workflow scheduling (ADR-0027). Cron is parsed at write time and after each fire,
 * so the per-minute tick is an index lookup on `next_run_at`.
 * Timezone: `trigger.timezone` if valid, then the user's timezone, then UTC.
 */

export const DEFAULT_WORKFLOW_TIMEZONE = parseIanaTimezone("UTC");

export function validateCronTrigger(
  trigger: WorkflowTrigger,
  opts: { timezone?: IanaTimezone } = {},
): { ok: true } | { ok: false; message: string } {
  if (trigger.kind !== "cron") return { ok: true };

  const timezone = trigger.timezone ?? opts.timezone ?? DEFAULT_WORKFLOW_TIMEZONE;

  try {
    CronExpressionParser.parse(trigger.schedule, {
      currentDate: new Date(),
      tz: timezone,
    }).next();

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: toMessage(err),
    };
  }
}

/** The trigger's own zone wins, so a workflow can stay on New York time after the user moves. */
export async function resolveWorkflowTimezone(
  userId: string,
  trigger: WorkflowTrigger,
): Promise<IanaTimezone> {
  // Every caller passes a parsed trigger (the revision service parses at its boundary;
  // the cron tick parses the `workflows.trigger` row before it builds its due rows), so
  // the `isIanaTimezone` guard is redundant. It stays until a later item deletes it.
  if (trigger.kind === "cron" && trigger.timezone && isIanaTimezone(trigger.timezone)) {
    return trigger.timezone;
  }

  return settings({ userId }).timezone();
}

/**
 * Next fire after `from` (default now), in `timezone`. Null for non-cron or bad
 * expressions, so one bad row cannot crash the dispatcher.
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

/** Approval copy derived from the trigger. */
export function workflowScheduleSummary(trigger: WorkflowTrigger): string {
  switch (trigger.kind) {
    case "cron":
      return describeCronSchedule(trigger.schedule, trigger.timezone);
    case "event":
      // Typed triggers keep the pre-#990 string: `validateActivationSchedule` compares it,
      // so an approval staged before a deploy still activates.
      return isRawEventType(trigger.type) && trigger.rawKind
        ? `For every ${eventTriggerPhrase(trigger)} event; Alfred evaluates semantic conditions inside the run`
        : "For every Gmail delivery; Alfred evaluates semantic conditions inside the run";
    case "manual":
      return "Manual runs only";
    case "on_signal":
      return `On signal: ${trigger.name}`;
    default:
      return assertNever(trigger, "workflow trigger kind");
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
