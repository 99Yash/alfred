import { db } from "@alfred/db";
import { workflows, type WorkflowTrigger } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";
import { createRun } from "../agent/service";
import { enqueueRun } from "../agent/queue";
import { computeNextRunAt, resolveWorkflowTimezone } from "./scheduling";

/**
 * One tick of the generic workflow dispatcher (ADR-0027).
 *
 * Reads up to `BATCH` rows from the partial cron index, then per row:
 *
 *  1. **CAS-advance `next_run_at`** — `UPDATE … WHERE id=? AND
 *     next_run_at=oldNext` returns 0 rows if another tick worker (or a
 *     manual write) already advanced the row. We bail on miss without
 *     creating a run, guaranteeing at-most-one fire per scheduled
 *     instant across racing workers.
 *  2. **`createRun`** with `trigger: { kind: 'cron', scheduledFor }`.
 *  3. **`enqueueRun`** with `jobId: workflow:{id}:scheduled:{iso}` —
 *     BullMQ's native dedup makes a retried tick (e.g. attempt 2 after
 *     a Redis blip) a no-op on duplicate jobId.
 *
 * A crash between step 1 and step 2/3 produces a missed fire (row
 * advanced, no run created). Personal-scale ADR-0027 documents this as
 * acceptable — the next scheduled fire produces a fresh row. Mitigation
 * via 2PC / outbox is deferred until missed-fire data shows it's worth
 * the complexity.
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

interface DueRow {
  id: string;
  slug: string;
  userId: string;
  brief: string | null;
  trigger: WorkflowTrigger;
  nextRunAt: Date;
}

export async function dispatchDueCronWorkflows(now: Date = new Date()): Promise<TickResult> {
  const due = await selectDueRows(now);

  let enqueued = 0;
  let raced = 0;
  let invalid = 0;
  let failed = 0;

  for (const row of due) {
    try {
      const result = await dispatchOne(row);
      if (result === "enqueued") enqueued++;
      else if (result === "raced") raced++;
      else if (result === "invalid") invalid++;
    } catch (err) {
      failed++;
      console.warn(
        `[workflows:tick] failed for workflow=${row.slug} (${row.id}):`,
        err instanceof Error ? err.message : String(err),
      );
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
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.status, "active"),
        sql`${workflows.trigger}->>'kind' = 'cron'`,
        sql`${workflows.nextRunAt} <= ${now.toISOString()}`,
      ),
    )
    .orderBy(workflows.nextRunAt)
    .limit(BATCH);

  return rows.flatMap((r) => (r.nextRunAt ? [{ ...r, nextRunAt: r.nextRunAt }] : []));
}

async function dispatchOne(row: DueRow): Promise<"enqueued" | "raced" | "invalid"> {
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
      .set({ nextRunAt: null, updatedAt: new Date() })
      .where(and(eq(workflows.id, row.id), eq(workflows.nextRunAt, scheduledFor)));
    return "invalid";
  }

  // CAS: only this tick worker may advance the row from the instant we
  // SELECTed. A racing worker hits 0 rows updated and bails. drizzle's
  // `.update().returning()` is the cleanest way to read affected rows.
  const updated = await db()
    .update(workflows)
    .set({
      nextRunAt: newNext,
      lastScheduledAt: scheduledFor,
      updatedAt: new Date(),
    })
    .where(and(eq(workflows.id, row.id), eq(workflows.nextRunAt, scheduledFor)))
    .returning({ id: workflows.id });

  if (updated.length === 0) {
    return "raced";
  }

  // `createRun` → `requireWorkflow` looks the slug up in the in-memory
  // builtin registry. When m12a's CRUD lands and active cron rows can
  // be user-authored, an unregistered slug will throw here — the CAS
  // above will have already advanced, so the throw turns into a
  // silently lost run (counted as `failed`). The m13 execution stub
  // is supposed to catch this inside `createRun` and produce a
  // `failed` row instead of throwing.
  const { runId } = await createRun({
    userId: row.userId,
    workflowSlug: row.slug,
    brief: row.brief ?? undefined,
    trigger: { kind: "cron", scheduledFor: scheduledForIso },
  });

  // jobId dedup defends against a tick retry (BullMQ attempts) firing a
  // second job for the same scheduled instant. Different `scheduledFor`
  // values produce different jobIds, so the *next* fire isn't blocked.
  //
  // ADR-0027's literal example used `:` separators, but BullMQ's
  // `Custom Id cannot contain :` check forbids them (see
  // bullmq/.../job.js). We use `.` separators and the millisecond
  // timestamp (sub-second uniqueness we never schedule at, but still
  // colon-free + numerically sortable).
  await enqueueRun(runId, {
    jobId: `workflow.${row.id}.scheduled.${scheduledFor.getTime()}`,
  });

  return "enqueued";
}
