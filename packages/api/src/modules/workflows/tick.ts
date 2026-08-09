import { db } from "@alfred/db";
import { workflows } from "@alfred/db/schemas";
import { workflowTriggerSchema, type WorkflowTrigger } from "@alfred/contracts";
import { and, eq, sql } from "drizzle-orm";
import { startRunInTx } from "@alfred/assistant/execution";
import { computeNextRunAt, resolveWorkflowTimezone } from "./scheduling";
import { toMessage } from "@alfred/contracts";

/**
 * One tick of the generic workflow dispatcher (ADR-0027).
 *
 * Reads up to `BATCH` rows from the partial cron index, then per row:
 *
 *  1. In one database transaction, CAS-advance `next_run_at` and create the
 *     database-unique pending occurrence. A racing worker updates zero rows.
 *  2. After commit, enqueue with `jobId: workflow.{id}.scheduled.{millis}`.
 *     A Redis/process failure leaves the pending row for the recovery sweep.
 */
const BATCH = 100;

export interface TickResult {
  scanned: number;
  enqueued: number;
  raced: number;
  /**
   * Rows whose cron expression failed to parse — distinct from CAS races
   * (`raced`) so monitoring can alert on broken schedules without false
   * positives from legitimate worker contention.
   */
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
  // The partial `workflows_next_run_at_idx` covers exactly this WHERE
  // clause; the planner returns the matching rows ordered by
  // `next_run_at` ASC for free.
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

  // Compute the *next* fire before the CAS so we can write both columns
  // atomically. `cron-parser` runs in the workflow's resolved tz; a
  // malformed schedule returns null and falls through to a clear log.
  //
  // `from: scheduledFor` (not `from: now`) keeps cron spacing
  // deterministic when a tick is mildly delayed. The catch: if a row
  // sat in the index with a stale `next_run_at` (e.g. paused for days
  // and then reactivated without re-priming), this will replay every
  // missed period one-per-tick until caught up. m12a's CRUD activate
  // path is responsible for re-priming `next_run_at` from now() on
  // status → 'active'; until that lands, no caller produces a stale
  // active cron row (builtin seeder writes `next_run_at = null`).
  const timezone = await resolveWorkflowTimezone(row.userId, row.trigger);
  const newNext = computeNextRunAt(row.trigger, { from: scheduledFor, timezone });
  if (!newNext) {
    console.warn(
      `[workflows:tick] cron-parser returned null for workflow=${row.slug} (${row.id}); pausing partial-index entry`,
    );
    // Null `next_run_at` removes the row from the partial index until
    // a user edit fixes the schedule — better than re-firing every
    // tick on a broken expression.
    await db()
      .update(workflows)
      .set({ nextRunAt: null })
      .where(and(eq(workflows.id, row.id), eq(workflows.nextRunAt, scheduledFor)));
    return "invalid";
  }

  // CAS: only this tick worker may advance the row from the instant we
  // SELECTed. A racing worker hits 0 rows updated and bails. drizzle's
  // `.update().returning()` is the cleanest way to read affected rows.
  const occurrence = {
    kind: "cron",
    workflowId: row.id,
    revisionId: row.isBuiltin ? null : row.publishedRevisionId,
    scheduledFor: scheduledForIso,
  } as const;
  // The CAS claim, the run row, and the enqueue are one operation. `claim`
  // runs the CAS on the transaction executor; a racing worker updates zero
  // rows and returns `null` (no run, no enqueue). `startRunInTx` creates the
  // run on that same transaction and enqueues only after commit.
  //
  // jobId dedup defends against a tick retry (BullMQ attempts) firing a
  // second job for the same scheduled instant. Different `scheduledFor`
  // values produce different jobIds, so the *next* fire isn't blocked.
  //
  // ADR-0027's literal example used `:` separators, but BullMQ's
  // `Custom Id cannot contain :` check forbids them (see
  // bullmq/.../job.js). We use `.` separators and the millisecond
  // timestamp (sub-second uniqueness we never schedule at, but still
  // colon-free + numerically sortable).
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
