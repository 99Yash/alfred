import { db } from "@alfred/db";
import { workflows } from "@alfred/db/schemas";
import { workflowTriggerSchema, type WorkflowTrigger } from "@alfred/contracts";
import { and, eq, sql } from "drizzle-orm";
import { startRunInTx } from "@alfred/assistant/execution";
import { computeNextRunAt, resolveWorkflowTimezone } from "./scheduling";
import { toMessage } from "@alfred/contracts";

/**
 * One tick of the workflow dispatcher (ADR-0027). For up to `BATCH` due rows:
 *  1. In one transaction, CAS-advance `next_run_at` and create the pending occurrence.
 *  2. After commit, enqueue. If that fails, the recovery sweep finds the pending row.
 */
const BATCH = 100;

export interface TickResult {
  scanned: number;
  enqueued: number;
  raced: number;
  /** Broken cron expressions, apart from `raced` so alerts skip normal contention. */
  invalid: number;
  failed: number;
}

export interface TickDependencies {
  startRunInTx?: typeof startRunInTx;
}

interface DueRow {
  id: string;
  slug: string;
  userId: string;
  brief: string | null;
  trigger: WorkflowTrigger;
  nextRunAt: Date;
  publishedRevisionId: string | null;
  isBuiltin: boolean;
}

export async function dispatchDueCronWorkflows(
  now: Date = new Date(),
  dependencies: TickDependencies = {},
): Promise<TickResult> {
  const due = await selectDueRows(now);

  let enqueued = 0;
  let raced = 0;
  let invalid = 0;
  let failed = 0;

  for (const row of due) {
    try {
      const result = await dispatchOne(row, dependencies);

      if (result === "enqueued") enqueued++;
      else if (result === "raced") raced++;
      else if (result === "invalid") invalid++;
    } catch (err) {
      failed++;
      console.warn(`[workflows:tick] failed for workflow=${row.slug} (${row.id}):`, toMessage(err));
    }
  }

  if (due.length > 0) {
    console.log(
      `[workflows:tick] scanned=${due.length} enqueued=${enqueued} raced=${raced} invalid=${invalid} failed=${failed}`,
    );
  }

  return { scanned: due.length, enqueued, raced, invalid, failed };
}

async function selectDueRows(now: Date): Promise<DueRow[]> {
  // `workflows_next_run_at_idx` is a partial index over exactly this WHERE.
  const rows = await db()
    .select({
      id: workflows.id,
      slug: workflows.slug,
      userId: workflows.userId,
      brief: workflows.brief,
      trigger: workflows.trigger,
      nextRunAt: workflows.nextRunAt,
      publishedRevisionId: workflows.publishedRevisionId,
      isBuiltin: workflows.isBuiltin,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.status, "active"),
        sql`${workflows.blocked} IS NULL`,
        sql`${workflows.trigger}->>'kind' = 'cron'`,
        sql`${workflows.nextRunAt} <= ${now.toISOString()}`,
      ),
    )
    .orderBy(workflows.nextRunAt)
    .limit(BATCH);

  const due: DueRow[] = [];

  for (const row of rows) {
    if (!row.nextRunAt) continue;

    const trigger = workflowTriggerSchema.safeParse(row.trigger);

    if (!trigger.success) {
      console.warn(
        `[workflows:tick] invalid trigger for workflow=${row.slug} (${row.id}); pausing partial-index entry: ${trigger.error.message}`,
      );
      await db()
        .update(workflows)
        .set({ nextRunAt: null })
        .where(and(eq(workflows.id, row.id), eq(workflows.nextRunAt, row.nextRunAt)));
      continue;
    }

    due.push({ ...row, trigger: trigger.data, nextRunAt: row.nextRunAt });
  }

  return due;
}

async function dispatchOne(
  row: DueRow,
  dependencies: TickDependencies,
): Promise<"enqueued" | "raced" | "invalid"> {
  const scheduledFor = row.nextRunAt;
  const scheduledForIso = scheduledFor.toISOString();

  // From `scheduledFor`, not now, so a late tick keeps the spacing. A row with an old
  // `next_run_at` replays each missed period, one per tick; activation re-primes from now.
  const timezone = await resolveWorkflowTimezone(row.userId, row.trigger);
  const newNext = computeNextRunAt(row.trigger, { from: scheduledFor, timezone });

  if (!newNext) {
    console.warn(
      `[workflows:tick] cron-parser returned null for workflow=${row.slug} (${row.id}); pausing partial-index entry`,
    );
    // Null drops the row from the index until the user fixes the schedule.
    await db()
      .update(workflows)
      .set({ nextRunAt: null })
      .where(and(eq(workflows.id, row.id), eq(workflows.nextRunAt, scheduledFor)));

    return "invalid";
  }

  // CAS from the instant we selected; a racing worker updates 0 rows.
  const occurrence = {
    kind: "cron",
    workflowId: row.id,
    revisionId: row.isBuiltin ? null : row.publishedRevisionId,
    scheduledFor: scheduledForIso,
  } as const;

  // Claim, run row, and enqueue are one operation. A racing worker gets `null`.
  // The jobId blocks a retried tick from firing twice for one instant.
  // BullMQ forbids `:` in custom ids, so use `.` and milliseconds.
  const claimed = await (dependencies.startRunInTx ?? startRunInTx)({
    claim: async (tx) => {
      const updated = await tx
        .update(workflows)
        .set({ nextRunAt: newNext, lastScheduledAt: scheduledFor })
        .where(and(eq(workflows.id, row.id), eq(workflows.nextRunAt, scheduledFor)))
        .returning({ id: workflows.id });

      if (updated.length === 0) return null;

      return {
        userId: row.userId,
        workflowSlug: row.slug,
        workflowRevisionId: row.isBuiltin ? null : row.publishedRevisionId,
        brief: row.brief ?? undefined,
        occurrence,
        trigger: { kind: "cron", scheduledFor: scheduledForIso },
      };
    },
    enqueue: { jobId: `workflow.${row.id}.scheduled.${scheduledFor.getTime()}` },
  });

  if (!claimed) return "raced";

  return "enqueued";
}
