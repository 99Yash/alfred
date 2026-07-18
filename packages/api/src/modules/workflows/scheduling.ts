import type { WorkflowTrigger } from "@alfred/contracts";
import { CronExpressionParser } from "cron-parser";
import { isValidTimezone } from "../briefing/preferences";
import { resolveUserTimezone } from "../timezone";

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

export const DEFAULT_WORKFLOW_TIMEZONE = "UTC";

export function validateCronTrigger(
  trigger: WorkflowTrigger,
  opts: { timezone?: string } = {},
): { ok: true } | { ok: false; message: string } {
  if (trigger.kind !== "cron") return { ok: true };
  const timezone = trigger.timezone ?? opts.timezone ?? DEFAULT_WORKFLOW_TIMEZONE;
  if (trigger.timezone && !isValidTimezone(trigger.timezone)) {
    return { ok: false, message: `invalid timezone '${trigger.timezone}'` };
  }
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
): Promise<string> {
  if (trigger.kind === "cron" && trigger.timezone && isValidTimezone(trigger.timezone)) {
    return trigger.timezone;
  }
  return resolveUserTimezone(userId);
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
  opts: { from?: Date; timezone: string },
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
