import {
  authorableEventTriggerSchema,
  isIanaTimezone,
  LOADABLE_INTEGRATION_SLUGS,
} from "@alfred/contracts";
import type { WriteTransaction } from "replicache";
import { z } from "zod";
import { SYNC_MODEL } from "../sync-model";
import { workflowStatusSchema } from "../schemas";
import type { SyncedWorkflow } from "../schemas";

const CRON_MONTH_NAMES = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
} satisfies Readonly<Record<string, number>>;

const CRON_DAY_NAMES = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
} satisfies Readonly<Record<string, number>>;

function cronFieldValue(value: string, names?: Readonly<Record<string, number>>): number | null {
  if (/^\d+$/.test(value)) return Number(value);

  return names?.[value.toUpperCase()] ?? null;
}

function isValidCronField(
  field: string,
  min: number,
  max: number,
  names?: Readonly<Record<string, number>>,
): boolean {
  for (const part of field.split(",")) {
    const [range, step] = part.split("/");

    if (!range || (step !== undefined && (!/^\d+$/.test(step) || Number(step) < 1))) {
      return false;
    }

    if (range === "*") continue;
    const bounds = range.split("-");

    if (bounds.length > 2) return false;
    const values: number[] = [];

    for (const bound of bounds) {
      const n = cronFieldValue(bound, names);

      if (n === null) return false;

      if (n < min || n > max) return false;
      values.push(n);
    }

    if (values.length === 2 && values[0]! > values[1]!) return false;
  }

  return true;
}

/** Quick 5-field cron check. The server checks again with cron-parser. */
export function isLikelyValidWorkflowCron(schedule: string): boolean {
  const parts = schedule.trim().split(/\s+/);

  if (parts.length !== 5) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  return (
    isValidCronField(minute ?? "", 0, 59) &&
    isValidCronField(hour ?? "", 0, 23) &&
    isValidCronField(dayOfMonth ?? "", 1, 31) &&
    isValidCronField(month ?? "", 1, 12, CRON_MONTH_NAMES) &&
    isValidCronField(dayOfWeek ?? "", 0, 7, CRON_DAY_NAMES)
  );
}

/**
 * Triggers the editor can author. Narrower than `workflowTriggerSchema`: no `on_signal`.
 * The event arm is the one chat authoring uses. Only the server checks a raw kind was seen.
 */
export const authorableWorkflowTriggerSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("cron"),
      schedule: z.string().min(1).max(120),
      timezone: z.string().max(64).optional(),
    }),
    authorableEventTriggerSchema,
    z.object({ kind: z.literal("manual") }),
  ])
  .superRefine((trigger, ctx) => {
    if (trigger.kind !== "cron") return;

    if (!isLikelyValidWorkflowCron(trigger.schedule)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Use a valid 5-field cron expression",
        path: ["schedule"],
      });
    }

    if (trigger.timezone && !isIanaTimezone(trigger.timezone)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `'${trigger.timezone}' is not a valid IANA timezone`,
        path: ["timezone"],
      });
    }
  });

export type AuthorableWorkflowTrigger = z.infer<typeof authorableWorkflowTriggerSchema>;

/** Patch a user-authored workflow with only the changed fields. */
export const workflowUpdateArgsSchema = z.object({
  slug: z.string().min(1),
  /** The row version the editor read before this change. */
  expectedRowVersion: z.number().int().positive(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2_000).nullable().optional(),
  brief: z.string().max(20_000).nullable().optional(),
  allowedIntegrations: z.array(z.enum(LOADABLE_INTEGRATION_SLUGS)).max(32).optional(),
  status: workflowStatusSchema.optional(),
  trigger: authorableWorkflowTriggerSchema.optional(),
});

export type WorkflowUpdateArgs = z.infer<typeof workflowUpdateArgsSchema>;

export async function workflowUpdateClient(
  tx: WriteTransaction,
  args: WorkflowUpdateArgs,
): Promise<void> {
  const current = await SYNC_MODEL.workflow.get(tx, { slug: args.slug });

  if (!current) return;

  if (current.isBuiltin) return;

  const next: SyncedWorkflow = {
    ...current,
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(args.brief !== undefined ? { brief: args.brief } : {}),
    ...(args.allowedIntegrations !== undefined
      ? { allowedIntegrations: args.allowedIntegrations }
      : {}),
    ...(args.status !== undefined ? { status: args.status } : {}),
    ...(args.trigger !== undefined ? { trigger: args.trigger } : {}),
    rowVersion: current.rowVersion + 1,
  };

  await SYNC_MODEL.workflow.put(tx, next);
}
