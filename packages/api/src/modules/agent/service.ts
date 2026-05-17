import { db } from "@alfred/db";
import { agentRuns, type AgentRunTrigger } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";
import { requireWorkflow } from "./registry";
import type { WakeCondition, WorkflowInput } from "./types";

interface PgErrorLike {
  code?: string;
}

/**
 * `true` when the given error is a Postgres unique-violation (SQLSTATE
 * 23505). Used by `/api/agent/runs` and the OAuth-callback trigger to
 * detect a duplicate `agent_runs.dedup_key` and surface it as a 409 /
 * silent no-op respectively, instead of leaking the raw constraint name.
 */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as PgErrorLike).code === "23505";
}

/**
 * After this much silence on `last_checkpoint_at`, a `running` row is
 * presumed abandoned and may be reclaimed by another worker. Shared
 * between the resume sweep (which re-enqueues stale rows) and the
 * executor's `leaseRun` (which lets a stale row be re-leased and bumps
 * the attempt counter). Pick a value comfortably above the worker
 * heartbeat interval so a single missed beat doesn't trigger reclaim.
 */
export const STALE_RUN_LEASE_MS = 60_000;

export interface CreateRunArgs extends WorkflowInput {
  userId: string;
  workflowSlug: string;
  /**
   * What caused this run to be created (ADR-0027). Required — every
   * call-site declares its kind explicitly so the unified dispatcher
   * surface stays auditable. `metadata` remains for diagnostic
   * breadcrumbs (e.g. webhook delivery id, internal idempotency).
   */
  trigger: AgentRunTrigger;
}

export interface CreateRunResult {
  runId: string;
}

/**
 * Persist a new run row in `pending` state. The caller (an HTTP route or
 * a cron trigger) is responsible for enqueueing the BullMQ job afterwards
 * — keeping persistence and enqueue separate means a Redis blip won't
 * orphan a row, and a recovery sweep can re-enqueue from the table.
 *
 * Workflows that opt into singleton semantics expose a `dedupKey` hook;
 * its value lands on `agent_runs.dedup_key` and the partial unique index
 * (user_id, workflow_slug, dedup_key) WHERE dedup_key IS NOT NULL AND
 * status NOT IN ('failed', 'cancelled') turns a duplicate into a Postgres
 * `23505` unique-violation. Callers either catch that (OAuth-callback
 * trigger logs + continues) or surface it as a 4xx (the generic /runs
 * endpoint).
 */
export async function createRun(args: CreateRunArgs): Promise<CreateRunResult> {
  const workflow = requireWorkflow(args.workflowSlug);
  const initialState = workflow.initialState({
    brief: args.brief,
    input: args.input,
    metadata: args.metadata,
  });

  const dedupKey =
    workflow.dedupKey?.({
      userId: args.userId,
      brief: args.brief,
      input: args.input,
      metadata: args.metadata,
    }) ?? null;

  const inserted = await db()
    .insert(agentRuns)
    .values({
      userId: args.userId,
      workflowSlug: workflow.slug,
      brief: args.brief,
      state: (initialState as object) ?? {},
      currentStep: workflow.initialStep,
      metadata: (args.metadata as object) ?? {},
      trigger: args.trigger,
      status: "pending",
      dedupKey,
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
