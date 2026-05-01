import { db } from "@alfred/db";
import { agentRuns } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";
import { requireWorkflow } from "./registry";
import type { WakeCondition, WorkflowInput } from "./types";

export interface CreateRunArgs extends WorkflowInput {
  userId: string;
  workflowSlug: string;
}

export interface CreateRunResult {
  runId: string;
}

/**
 * Persist a new run row in `pending` state. The caller (an HTTP route or
 * a cron trigger) is responsible for enqueueing the BullMQ job afterwards
 * — keeping persistence and enqueue separate means a Redis blip won't
 * orphan a row, and a recovery sweep can re-enqueue from the table.
 */
export async function createRun(args: CreateRunArgs): Promise<CreateRunResult> {
  const workflow = requireWorkflow(args.workflowSlug);
  const initialState = workflow.initialState({
    brief: args.brief,
    input: args.input,
    metadata: args.metadata,
  });

  const inserted = await db()
    .insert(agentRuns)
    .values({
      userId: args.userId,
      workflowSlug: workflow.slug,
      brief: args.brief,
      state: (initialState as object) ?? {},
      currentStep: workflow.initialStep,
      metadata: (args.metadata as object) ?? {},
      status: "pending",
    })
    .returning({ id: agentRuns.id });

  const row = inserted[0];
  if (!row) throw new Error("[agent] failed to insert run row");
  return { runId: row.id };
}

export interface SignalArgs {
  runId: string;
  /** When provided, only fire if the wake condition matches (HIL approvalId or signal name). */
  match?:
    | { kind: "hil"; approvalId: string }
    | { kind: "signal"; name: string }
    | { kind: "any" };
}

/**
 * Move a `waiting` run back to `runnable` if its wake condition matches.
 * Returns true if the run was woken, false if it was not waiting or the
 * match failed (the caller can treat both as "no-op, already moved on").
 */
export async function signalRun(args: SignalArgs): Promise<boolean> {
  const match = args.match ?? { kind: "any" };
  return await db().transaction(async (tx) => {
    const rows = await tx
      .select({
        id: agentRuns.id,
        status: agentRuns.status,
        wakeCondition: agentRuns.wakeCondition,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, args.runId))
      .for("update");
    const row = rows[0];
    if (!row) return false;
    if (row.status !== "waiting") return false;

    if (match.kind !== "any") {
      const wake = row.wakeCondition as WakeCondition | null;
      if (!wake || wake.kind !== match.kind) return false;
      if (match.kind === "hil" && wake.kind === "hil" && wake.approvalId !== match.approvalId) {
        return false;
      }
      if (match.kind === "signal" && wake.kind === "signal" && wake.name !== match.name) {
        return false;
      }
    }

    await tx
      .update(agentRuns)
      .set({
        status: "runnable",
        wakeCondition: null,
        lastCheckpointAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentRuns.id, args.runId));
    return true;
  });
}

export interface RunSummary {
  id: string;
  userId: string;
  workflowSlug: string;
  status: string;
  currentStep: string;
  attempt: number;
  brief: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  lastCheckpointAt: Date | null;
  wakeCondition: unknown;
  output: unknown;
  error: unknown;
}

export async function getRun(runId: string, userId: string): Promise<RunSummary | null> {
  const rows = await db()
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)));
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    workflowSlug: row.workflowSlug,
    status: row.status,
    currentStep: row.currentStep,
    attempt: row.attempt,
    brief: row.brief,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    lastCheckpointAt: row.lastCheckpointAt,
    wakeCondition: row.wakeCondition,
    output: row.output,
    error: row.error,
  };
}

/**
 * Find run rows that are claimable by the worker pool: pending or runnable,
 * plus running/heart-beat-stale ones whose owning worker died. The
 * `staleAfterMs` threshold is the worker's lease window — anything not
 * checkpoint-bumped within it is presumed dead.
 */
export async function findResumableRunIds(opts: {
  staleAfterMs: number;
  limit?: number;
}): Promise<string[]> {
  const limit = opts.limit ?? 100;
  const result = await db().execute(sql`
    SELECT id FROM agent_runs
    WHERE status IN ('pending', 'runnable')
       OR (status = 'running' AND (
         last_checkpoint_at IS NULL
         OR last_checkpoint_at < (now() - make_interval(secs => ${opts.staleAfterMs / 1000}))
       ))
    ORDER BY last_checkpoint_at NULLS FIRST, id
    LIMIT ${limit}
  `);
  const rawRows = (result as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
  const rows = (Array.isArray(rawRows) ? rawRows : []) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Heartbeat on a leased run — bumps `last_checkpoint_at` so the resume
 * sweep doesn't yank the run out from under us during a long step.
 */
export async function heartbeatRun(runId: string): Promise<void> {
  await db()
    .update(agentRuns)
    .set({ lastCheckpointAt: new Date() })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "running")));
}
