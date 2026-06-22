import { db, rowsFromExecute } from "@alfred/db";
import {
  actionStagings,
  agentRuns,
  workflows,
  type Workflow as WorkflowRow,
} from "@alfred/db/schemas";
import {
  agentRunTriggerSchema,
  runStatusSchema,
  wakeConditionSchema,
  type AgentRunTrigger,
} from "@alfred/schemas";
import { and, eq, sql } from "drizzle-orm";
import { publishEvent } from "../../events/publish";
import { getWorkflow } from "./registry";
import {
  isTerminalStatus,
  type ApprovalKind,
  type AgentDbExecutor,
  type RunStatus,
  type WakeCondition,
  type Workflow,
  type WorkflowInput,
} from "./types";
import { userAuthoredBriefWorkflow } from "./workflows/user-authored-brief";

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

type UserAuthoredWorkflowRow = Pick<WorkflowRow, "brief" | "allowedIntegrations" | "isBuiltin">;

interface ResolvedWorkflowForRun {
  workflow: Workflow<unknown>;
  workflowSlug: string;
  userAuthoredRow?: UserAuthoredWorkflowRow;
}

export async function resolveWorkflowForRun(args: {
  userId: string;
  workflowSlug: string;
  tx?: AgentDbExecutor;
}): Promise<ResolvedWorkflowForRun> {
  const registered = getWorkflow(args.workflowSlug);
  if (registered) return { workflow: registered, workflowSlug: registered.slug };

  const ex = args.tx ?? db();
  const rows = await ex
    .select({
      brief: workflows.brief,
      allowedIntegrations: workflows.allowedIntegrations,
      isBuiltin: workflows.isBuiltin,
    })
    .from(workflows)
    .where(and(eq(workflows.userId, args.userId), eq(workflows.slug, args.workflowSlug)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(`[agent] no workflow registered or authored for slug=${args.workflowSlug}`);
  }
  if (row.isBuiltin) {
    throw new Error(
      `[agent] builtin workflow slug=${args.workflowSlug} exists in DB but is not registered in code`,
    );
  }

  return {
    workflow: userAuthoredBriefWorkflow as Workflow<unknown>,
    workflowSlug: args.workflowSlug,
    userAuthoredRow: row,
  };
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
export async function createRun(
  args: CreateRunArgs,
  tx?: AgentDbExecutor,
): Promise<CreateRunResult> {
  const trigger = agentRunTriggerSchema.parse(args.trigger);
  const ex = tx ?? db();
  const resolved = await resolveWorkflowForRun({
    userId: args.userId,
    workflowSlug: args.workflowSlug,
    tx: ex,
  });
  const workflow = resolved.workflow;
  const workflowSlug = resolved.workflowSlug;
  let brief = args.brief;
  let metadata = args.metadata ?? {};

  if (resolved.userAuthoredRow) {
    const row = resolved.userAuthoredRow;
    brief = brief ?? row.brief ?? undefined;
    const metadataAllowedIntegrations = Array.isArray(metadata.allowedIntegrations)
      ? metadata.allowedIntegrations
      : row.allowedIntegrations;
    metadata = { ...metadata, allowedIntegrations: metadataAllowedIntegrations };
  }

  const workflowInput = {
    userId: args.userId,
    trigger,
    brief,
    input: args.input,
    metadata,
  };

  const initialState = workflow.initialState(workflowInput);
  const transcript = (await workflow.initialTranscript?.(workflowInput, { db: ex })) ?? [];

  const dedupKey = workflow.dedupKey?.(workflowInput) ?? null;

  const inserted = await ex
    .insert(agentRuns)
    .values({
      userId: args.userId,
      workflowSlug,
      brief,
      state: (initialState as object) ?? {},
      transcript,
      currentStep: workflow.initialStep,
      metadata: metadata as object,
      trigger,
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
    | { kind: "hil"; approvalId: string; approvalKind?: ApprovalKind }
    | { kind: "signal"; name: string }
    | { kind: "any" };
}

export type SignalOutcome =
  | "woken"
  | "not_found"
  | "not_waiting"
  | "already_terminal"
  | "wake_mismatch";

// Typed loosely so callers can share the helper from inside their own
// outer transaction without coupling this module to one concrete Drizzle
// transaction instantiation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentTx = any;

/**
 * Move a `waiting` run back to `runnable` if its wake condition matches.
 * Returns true if the run was woken, false if it was not waiting or the
 * match failed (the caller can treat both as "no-op, already moved on").
 */
export async function signalRun(args: SignalArgs): Promise<boolean> {
  const outcome = await db().transaction((tx) => signalRunInTx(tx, args));
  return outcome === "woken";
}

export async function signalRunInTx(tx: AgentTx, args: SignalArgs): Promise<SignalOutcome> {
  const match = args.match ?? { kind: "any" };
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
  if (!row) return "not_found";
  const status = runStatusSchema.parse(row.status);
  if (status !== "waiting") {
    return isTerminalStatus(status) ? "already_terminal" : "not_waiting";
  }

  if (match.kind !== "any") {
    const wake = wakeConditionSchema.nullable().parse(row.wakeCondition);
    if (!wake || wake.kind !== match.kind) return "wake_mismatch";
    if (match.kind === "hil" && wake.kind === "hil" && wake.approvalId !== match.approvalId) {
      return "wake_mismatch";
    }
    if (match.kind === "hil" && wake.kind === "hil" && match.approvalKind) {
      // Treat a missing `approvalKind` on the wake as "step" — pre-m13
      // HIL wakes predate the field, and the only kind that existed
      // then was the implicit step approval. Symmetric with the
      // executor's interrupt-commit default (see executor.ts).
      const wakeKind = wake.approvalKind ?? "step";
      if (wakeKind !== match.approvalKind) return "wake_mismatch";
    }
    if (match.kind === "signal" && wake.kind === "signal" && wake.name !== match.name) {
      return "wake_mismatch";
    }
  }

  await tx
    .update(agentRuns)
    .set({
      status: "runnable",
      wakeCondition: null,
      lastCheckpointAt: new Date(),
    })
    .where(eq(agentRuns.id, args.runId));
  return "woken";
}

export interface CancelRunArgs {
  runId: string;
  /** Short human/programmatic reason — surfaced in `agent_runs.error.reason`. */
  reason: string;
  /**
   * User-facing reason copied onto pending approval rows cancelled with
   * the run. Defaults to `reason` for programmatic callers.
   */
  pendingApprovalRejectReason?: string;
}

export type CancelOutcome = "cancelled" | "already_terminal" | "not_found";

export interface CancelTxResult {
  outcome: CancelOutcome;
  /**
   * Ids of the gated `action_stagings` rows this cancel bulk-rejected.
   * The HTTP caller uses these to tear down each row's queued
   * expiry/notification jobs (otherwise they fire later and no-op, leaving
   * ghost jobs in Redis). Empty unless `outcome === "cancelled"`.
   */
  rejectedStagingIds: string[];
}

/**
 * Stop a run from any non-terminal state. Used by the approvals
 * "Reject and end run" action (Phase 5) and any future flow that needs
 * to abandon a parked or in-flight run. Idempotent: calling on an
 * already-terminal row is a no-op and reports `already_terminal`. The
 * caller (HTTP handler) typically treats `not_found` and
 * `already_terminal` as equivalent 4xx responses but they're distinct
 * here for observability.
 *
 * Atomicity: status flip + outbox event commit inside one tx so a
 * rolled-back update can't leak a phantom `cancelled` event downstream.
 */
export async function cancelRun(args: CancelRunArgs): Promise<CancelOutcome> {
  const result = await db().transaction((tx) => cancelRunInTx(tx, args));
  return result.outcome;
}

export async function cancelRunInTx(tx: AgentTx, args: CancelRunArgs): Promise<CancelTxResult> {
  const rows = await tx
    .select({
      id: agentRuns.id,
      userId: agentRuns.userId,
      status: agentRuns.status,
      currentStep: agentRuns.currentStep,
      attempt: agentRuns.attempt,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, args.runId))
    .for("update");
  const row = rows[0];
  if (!row) return { outcome: "not_found", rejectedStagingIds: [] };
  const status = runStatusSchema.parse(row.status);

  if (isTerminalStatus(status)) {
    return { outcome: "already_terminal", rejectedStagingIds: [] };
  }

  const now = new Date();
  await tx
    .update(agentRuns)
    .set({
      status: "cancelled",
      // Null the wake so a stale signal (e.g. a delayed approval
      // landing after cancellation) can't match — signalRun guards on
      // status='waiting' but defence-in-depth is cheap here.
      wakeCondition: null,
      error: { reason: args.reason, cancelledAt: now.toISOString() },
      endedAt: now,
      lastCheckpointAt: now,
      updatedAt: now,
    })
    .where(eq(agentRuns.id, args.runId));

  const rejectedStagings = await tx
    .update(actionStagings)
    .set({
      status: "rejected",
      rejectReason: args.pendingApprovalRejectReason ?? args.reason,
      decidedAt: now,
      rowVersion: sql`${actionStagings.rowVersion} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(actionStagings.runId, args.runId),
        eq(actionStagings.status, "pending"),
        eq(actionStagings.requiresApproval, true),
      ),
    )
    .returning({ id: actionStagings.id });

  await publishEvent({
    tx,
    userId: row.userId,
    kind: "agent.run",
    payload: {
      runId: row.id,
      phase: "cancelled",
      step: row.currentStep,
      attempt: row.attempt,
      error: args.reason,
    },
  });
  return {
    outcome: "cancelled",
    rejectedStagingIds: rejectedStagings.map((r: { id: string }) => r.id),
  };
}

export interface RunSummary {
  id: string;
  userId: string;
  workflowSlug: string;
  status: RunStatus;
  currentStep: string;
  attempt: number;
  brief: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  lastCheckpointAt: Date | null;
  wakeCondition: WakeCondition | null;
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
    status: runStatusSchema.parse(row.status),
    currentStep: row.currentStep,
    attempt: row.attempt,
    brief: row.brief,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    lastCheckpointAt: row.lastCheckpointAt,
    wakeCondition: wakeConditionSchema.nullable().parse(row.wakeCondition),
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
  const rows = rowsFromExecute<{ id: string }>(result);
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
