import { toMessage } from "@alfred/contracts";
import { db, rowsFromExecute, type DbTransaction } from "@alfred/db";
import { runAtomic } from "@alfred/db/helpers";
import {
  actionStagings,
  agentRuns,
  agentSteps,
  runIsNotTerminal,
  workflows,
} from "@alfred/db/schemas";
import {
  agentRunTriggerSchema,
  boundAgentRunError,
  runStatusSchema,
  wakeConditionSchema,
  type AgentRunTrigger,
} from "@alfred/contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import { emitReplicachePokes, publishEvent } from "@alfred/assistant/triggers";
// Cancel's post-commit obligations include tearing down the queued jobs of the
// stagings it bulk-rejected. The scheduling helpers live in `tool-runtime` (a
// sink), so owning the teardown here rather than describing it to callers adds
// no cycle.
import {
  removeApprovalExpiryJob,
  removeApprovalNotificationJob,
} from "@alfred/assistant/tool-runtime";
import { snapshotScratchToPostgres } from "./scratchpad/index";
import { enqueueRun } from "./queue";
import { getWorkflow, listWorkflows } from "./registry";
import { resolveWorkflowForRun } from "./resolve-workflow";
import {
  readSubAgentMetadata,
  subAgentDoneSignalName,
  subAgentParentRunIdMatches,
} from "./sub-agent-metadata";
import { startSubAgentWaitSpan, type SubAgentWaitOutcome } from "./runtime-spans";
import { finalizeCancelledRun } from "./terminal-closure";
import {
  isTerminalStatus,
  type AgentDbExecutor,
  type ApprovalKind,
  type RunStatus,
  type WakeCondition,
  type WorkflowInput,
} from "./types";
import { userAuthoredBriefWorkflow } from "./workflows/user-authored-brief";
import {
  workflowOccurrenceKey,
  type WorkflowOccurrenceIdentity,
} from "@alfred/db/workflow-occurrence";

/**
 * After this much silence on `last_checkpoint_at`, a `running` row is
 * presumed abandoned and may be reclaimed by another worker. Shared
 * between the resume sweep (which re-enqueues stale rows) and the
 * executor's `leaseRun` (which lets a stale row be re-leased and bumps
 * the attempt counter). Pick a value comfortably above the worker
 * heartbeat interval so a single missed beat doesn't trigger reclaim.
 */
export const STALE_RUN_LEASE_MS = 60_000;

/**
 * Resolve the effective stale-lease window for a run's current step (ADR-0070
 * §1.4, Lever A). A per-step `staleAfterMs` (declared on the `Step`) wins;
 * otherwise the default {@link STALE_RUN_LEASE_MS}. Synchronous and DB-free — it
 * reads the in-memory workflow registry, so it's safe to call inside the
 * `leaseRun` transaction (which holds `FOR UPDATE` on the run row).
 *
 * User-authored workflows keep their DB slug on `agent_runs` but execute the
 * shared user-authored-brief workflow body. When the registry misses, fall back
 * to that shared workflow's step definition before using the default.
 */
export function resolveStaleAfterMs(workflowSlug: string, stepId: string): number {
  const step = getWorkflow(workflowSlug)?.steps[stepId] ?? userAuthoredBriefWorkflow.steps[stepId];
  return step?.staleAfterMs ?? STALE_RUN_LEASE_MS;
}

/**
 * The smallest stale window across all registered steps, floored at the
 * default. The resume sweep selects `running` candidates at this floor in SQL,
 * then refines each against its precise per-step window in JS. Selecting at the
 * floor guarantees no genuinely-stale run is missed (any step's window is
 * >= this floor by construction) while keeping healthy long turns from being
 * re-enqueued every sweep only to be declined by `leaseRun`.
 */
export function minStaleAfterMs(): number {
  let min = STALE_RUN_LEASE_MS;
  for (const wf of listWorkflows()) {
    for (const step of Object.values(wf.steps)) {
      if (typeof step.staleAfterMs === "number" && step.staleAfterMs < min) {
        min = step.staleAfterMs;
      }
    }
  }
  return min;
}

type CronOccurrence = Extract<WorkflowOccurrenceIdentity, { kind: "cron" }>;
type EventOccurrence = Extract<WorkflowOccurrenceIdentity, { kind: "event" }>;
type ManualOccurrence = Extract<WorkflowOccurrenceIdentity, { kind: "manual" }>;
type ManualOccurrenceRequest = Omit<ManualOccurrence, "workflowId">;
type ReplayOccurrence = Extract<WorkflowOccurrenceIdentity, { kind: "replay" }>;

type CreateRunBase = Omit<WorkflowInput, "trigger"> & {
  userId: string;
  workflowSlug: string;
  /**
   * What caused this run to be created (ADR-0027). Required — every
   * call-site declares its kind explicitly so the unified dispatcher
   * surface stays auditable. `metadata` remains for diagnostic
   * breadcrumbs (e.g. webhook delivery id, internal idempotency).
   */
};

export type CreateRunArgs = CreateRunBase &
  (
    | {
        trigger: Extract<AgentRunTrigger, { kind: "cron" }>;
        /** Exact approved revision selected with the occurrence; null declares a builtin. */
        workflowRevisionId: string | null;
        occurrence: CronOccurrence;
      }
    | {
        trigger: Extract<AgentRunTrigger, { kind: "event" }>;
        /** Exact approved revision selected with the occurrence; null declares a builtin. */
        workflowRevisionId: string | null;
        occurrence: EventOccurrence;
      }
    | {
        trigger: Extract<AgentRunTrigger, { kind: "manual" }>;
        workflowRevisionId?: never;
        occurrence: ManualOccurrenceRequest;
      }
    | {
        trigger: Extract<AgentRunTrigger, { kind: "manual" }>;
        /** Replay explicitly selects the original or latest approved revision. */
        workflowRevisionId: string;
        occurrence: ReplayOccurrence;
      }
    | {
        trigger: Extract<AgentRunTrigger, { kind: "on_signal" }>;
        workflowRevisionId?: never;
        occurrence?: never;
      }
  );

export interface CreateRunResult {
  runId: string;
  /** False when this call found the run that already owns the occurrence. */
  created: boolean;
}

export interface ReplayRunArgs {
  userId: string;
  runId: string;
  requestId: string;
  revisionChoice: "original" | "latest";
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
  const occurrence = "occurrence" in args ? args.occurrence : undefined;
  const selectedRevisionId =
    "workflowRevisionId" in args ? (args.workflowRevisionId ?? undefined) : undefined;
  const replay = occurrence?.kind === "replay";
  const resolved = await resolveWorkflowForRun({
    userId: args.userId,
    workflowSlug: args.workflowSlug,
    workflowRevisionId: selectedRevisionId,
    requireSelectedRevision: trigger.kind === "cron" || trigger.kind === "event" || replay,
    tx: ex,
  });
  const workflow = resolved.workflow;
  const workflowSlug = resolved.workflowSlug;
  if (workflow.resumeOnly) {
    throw new Error(
      `[agent] workflow slug=${workflowSlug} is available only to resume existing runs`,
    );
  }
  let brief = args.brief;
  let metadata = args.metadata ?? {};

  if (resolved.userAuthoredRow) {
    const row = resolved.userAuthoredRow;
    // A revision-backed run executes only the definition it names. Caller
    // overrides would make workflowRevisionId claim one contract while the
    // transcript and integration ceiling execute another.
    brief = row.brief ?? undefined;
    metadata = {
      ...metadata,
      allowedIntegrations: row.allowedIntegrations,
      allowedTools: row.allowedTools,
      requiredCapabilities: row.requiredCapabilities,
    };
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

  const manualRequestKey =
    resolved.userAuthoredRow && trigger.kind === "manual" && occurrence?.kind === "manual"
      ? `manual:${occurrence.requestId}`
      : null;
  const occurrenceIdentity: WorkflowOccurrenceIdentity | undefined =
    occurrence?.kind === "manual"
      ? {
          ...occurrence,
          workflowId: resolved.userAuthoredRow?.workflowId ?? workflowSlug,
        }
      : occurrence;
  const occurrenceKey = occurrenceIdentity ? workflowOccurrenceKey(occurrenceIdentity) : undefined;
  const dedupKey = manualRequestKey ?? workflow.dedupKey?.(workflowInput) ?? null;

  const insert = ex.insert(agentRuns).values({
    userId: args.userId,
    workflowSlug,
    workflowRevisionId: resolved.userAuthoredRow?.revisionId ?? null,
    brief,
    state: (initialState as object) ?? {},
    transcript,
    currentStep: workflow.initialStep,
    metadata: metadata as object,
    trigger,
    status: "pending",
    dedupKey,
    occurrenceKey,
    replayOfRunId: occurrence?.kind === "replay" ? occurrence.replayOfRunId : undefined,
  });
  const inserted = occurrenceKey
    ? await insert
        .onConflictDoNothing({ target: [agentRuns.userId, agentRuns.occurrenceKey] })
        .returning({ id: agentRuns.id })
    : manualRequestKey
      ? await insert.onConflictDoNothing().returning({ id: agentRuns.id })
      : await insert.returning({ id: agentRuns.id });

  const row = inserted[0];
  if (!row && (occurrenceKey || manualRequestKey)) {
    const [existing] = await ex
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.userId, args.userId),
          eq(agentRuns.workflowSlug, workflowSlug),
          occurrenceKey
            ? eq(agentRuns.occurrenceKey, occurrenceKey)
            : eq(agentRuns.dedupKey, manualRequestKey!),
        ),
      )
      .limit(1);
    if (existing) return { runId: existing.id, created: false };
  }
  if (!row) throw new Error("[agent] failed to insert run row");
  return { runId: row.id, created: true };
}

/**
 * Persist a run row and place it on the agent queue in one call — the
 * ordinary-caller entry point of the execution state machine. It folds the
 * `createRun` (persist a `pending` row) and `enqueueRun` (hand the run to the
 * worker) pair behind one name so a caller cannot persist a run and forget to
 * enqueue it, or enqueue in the wrong order. Callers that need BullMQ dedup or a
 * delayed start (the cron and event dispatchers) pass `enqueueOpts`.
 *
 * The run is always enqueued, even when `createRun` returned an existing row for
 * a deduped occurrence: re-enqueueing an already-queued or in-flight run is safe
 * because lease arbitration is at the DB layer (FOR UPDATE SKIP LOCKED).
 */
export async function startRun(
  args: CreateRunArgs,
  enqueueOpts?: { delayMs?: number; jobId?: string },
): Promise<CreateRunResult> {
  const result = await createRun(args);
  await enqueueRun(result.runId, enqueueOpts);
  return result;
}

/**
 * Persist a run inside a caller-owned transaction and deliver it to the worker
 * after that transaction commits — one named operation for the occurrence-claim
 * path (`workflows/tick.ts`, ADR-0027). `claim` runs the caller's CAS and other
 * durable writes on the transaction executor and returns the run args, or `null`
 * when it lost the race (no run, no enqueue). `createRun` runs on that same
 * executor, so the claim and the run row are atomic. The enqueue fires only
 * after the transaction commits: enqueueing a run whose row is not yet committed
 * would let the worker lease a row it cannot see. The queue handle never leaves
 * execution, so a caller cannot split, re-order, or drop the deliver.
 */
export async function startRunInTx(spec: {
  claim: (tx: AgentDbExecutor) => Promise<CreateRunArgs | null>;
  enqueue?: { delayMs?: number; jobId?: string };
}): Promise<CreateRunResult | null> {
  const created = await db().transaction(async (tx) => {
    const args = await spec.claim(tx);
    if (!args) return null;
    return createRun(args, tx);
  });
  if (!created) return null;
  await enqueueRun(created.runId, spec.enqueue);
  return created;
}

/**
 * Deliver an already-persisted run to the worker — the execution-domain verb for
 * re-delivery. It serves the callers that legitimately hold a `runId` from a
 * larger write and must kick it separately: a best-effort chat-turn kick after
 * the outer transaction commits (`conversations`), re-delivery of a run woken by
 * an approval decision or its expiry sweep (`approvals`), and the parked-run
 * re-kicks in ops smokes. It wraps the module-private `enqueueRun` queue
 * primitive, so the BullMQ handle never leaves execution; with no public
 * `createRun` a caller cannot use it to split persistence from delivery.
 */
export async function redeliverRun(runId: string): Promise<void> {
  await enqueueRun(runId);
}

/**
 * Persist a chat-turn run inside the caller's chat-turn transaction, scoping the
 * insert to a SAVEPOINT (nested tx) so a dedup / per-thread unique-violation
 * rolls back only the failed insert and leaves the outer transaction alive to
 * recover via the caller's own SELECT. This owns the savepoint the conversations
 * chat-turn route previously hand-rolled around `createRun`; delivery is
 * deferred to `redeliverRun(runId)` after the outer transaction commits (a run
 * persisted here is `pending`, so the resume sweep recovers it if the kick is
 * dropped). The queue handle is never exposed, so this op can only persist — it
 * cannot deliver — which keeps the chat-turn split expressible without
 * re-exposing the raw create/enqueue pair.
 */
export async function persistChatTurnRunInTx(
  tx: DbTransaction,
  args: CreateRunArgs,
): Promise<CreateRunResult> {
  return runAtomic(tx, (sp) => createRun(args, sp));
}

/** Create a new user-authored occurrence linked to a prior run. */
export async function replayRun(args: ReplayRunArgs): Promise<CreateRunResult> {
  const [original] = await db()
    .select({
      id: agentRuns.id,
      workflowSlug: agentRuns.workflowSlug,
      workflowRevisionId: agentRuns.workflowRevisionId,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, args.runId), eq(agentRuns.userId, args.userId)))
    .limit(1);
  if (!original) throw new Error(`[agent] replay source run not found: ${args.runId}`);

  const [workflow] = await db()
    .select({
      id: workflows.id,
      isBuiltin: workflows.isBuiltin,
      publishedRevisionId: workflows.publishedRevisionId,
    })
    .from(workflows)
    .where(and(eq(workflows.userId, args.userId), eq(workflows.slug, original.workflowSlug)))
    .limit(1);
  if (!workflow || workflow.isBuiltin) {
    throw new Error("Only user-authored workflow runs can be replayed");
  }

  const workflowRevisionId =
    args.revisionChoice === "original" ? original.workflowRevisionId : workflow.publishedRevisionId;
  if (!workflowRevisionId) {
    throw new Error(`[agent] replay revision is unavailable for run=${args.runId}`);
  }

  return createRun({
    userId: args.userId,
    workflowSlug: original.workflowSlug,
    workflowRevisionId,
    trigger: { kind: "manual" },
    occurrence: {
      kind: "replay",
      workflowId: workflow.id,
      requestId: args.requestId,
      replayOfRunId: original.id,
      revisionChoice: args.revisionChoice,
    },
  });
}

export interface SignalArgs {
  runId: string;
  /** When provided, only fire if the wake condition matches (HIL approvalId or signal name). */
  match?:
    | { kind: "hil"; approvalId: string; approvalKind?: ApprovalKind | undefined }
    | { kind: "signal"; name: string }
    | { kind: "any" }
    | undefined;
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
    // drift-ok: FOR UPDATE held since the SELECT above, which returned unless
    // the status was exactly `waiting`.
    .update(agentRuns)
    .set({
      status: "runnable",
      wakeCondition: null,
      lastCheckpointAt: new Date(),
    })
    .where(eq(agentRuns.id, args.runId));
  return "woken";
}

/**
 * ADR-0073: when a sub-agent child reaches a terminal state, wake the parent
 * that is joining it. Reads the child's metadata, and if it is a sub-agent,
 * fires `sub_agent_done:<childRunId>` so a parent parked in `await_sub_agent`
 * flips back to `runnable`. Returns the parent's run id when it was actually
 * woken (so the caller can enqueue it for an immediate resume), else null —
 * a no-op when the run isn't a sub-agent, the parent already moved on, or the
 * parent isn't waiting on this child. Best-effort and idempotent.
 */
export async function signalParentOfSubAgent(childRunId: string): Promise<string | null> {
  const rows = await db()
    .select({ metadata: agentRuns.metadata, status: agentRuns.status })
    .from(agentRuns)
    .where(eq(agentRuns.id, childRunId))
    .limit(1);
  const sub = readSubAgentMetadata(rows[0]?.metadata);
  if (!sub) return null;
  const woken = await signalRun({
    runId: sub.parentRunId,
    match: { kind: "signal", name: subAgentDoneSignalName(childRunId) },
  });
  if (woken) {
    // #409: the parent just woke from its `await_sub_agent` park — record the
    // wait it spent joining this child, tagged with the child's terminal status.
    const outcome = subAgentOutcomeFromStatus(rows[0]?.status);
    if (outcome) {
      await emitSubAgentWaitSpan({ ex: db(), parentRunId: sub.parentRunId, childRunId, outcome });
    }
  }
  return woken ? sub.parentRunId : null;
}

/** Map a child run's raw status to a sub-agent-wait outcome; null when non-terminal. */
function subAgentOutcomeFromStatus(status: string | undefined): SubAgentWaitOutcome | null {
  if (status === "completed" || status === "failed" || status === "cancelled") return status;
  return null;
}

/**
 * Best-effort `runtime.sub_agent.wait` span for the parent that just woke from
 * an `await_sub_agent` park (#409). The park instant is the parent's latest
 * `interrupted` step's `ended_at`; if it can't be resolved we skip the span
 * rather than block the wake. Accepts an executor so it can run on the caller's
 * transaction (in-tx cancel) or a fresh connection (terminal-child signal).
 */
async function emitSubAgentWaitSpan(args: {
  ex: AgentDbExecutor;
  parentRunId: string;
  childRunId: string;
  outcome: SubAgentWaitOutcome;
}): Promise<void> {
  try {
    const rows = await args.ex
      .select({ stepId: agentSteps.stepId, endedAt: agentSteps.endedAt })
      .from(agentSteps)
      .where(and(eq(agentSteps.runId, args.parentRunId), eq(agentSteps.status, "interrupted")))
      .orderBy(desc(agentSteps.id))
      .limit(1);
    const park = rows[0];
    if (!park?.endedAt) return;
    startSubAgentWaitSpan({
      runId: args.parentRunId,
      startedAt: park.endedAt,
      childRunId: args.childRunId,
      parentStepId: park.stepId,
    }).end(args.outcome, new Date());
  } catch (err) {
    console.warn("[agent] sub-agent wait span failed for", args.childRunId, toMessage(err));
  }
}

export interface CancelRunArgs {
  runId: string;
  /** Short human/programmatic reason — surfaced in `agent_runs.error.reason`. */
  reason: string;
  /**
   * User-facing reason copied onto pending approval rows cancelled with
   * the run. Defaults to `reason` for programmatic callers.
   */
  pendingApprovalRejectReason?: string | undefined;
}

export type CancelOutcome = "cancelled" | "already_terminal" | "not_found";

/**
 * The `agent_runs.error.reason` a sub-agent child records when its parent's
 * cancel cascaded onto it (#559b). Distinct from the parent's own reason so an
 * operator reading the child row can tell a delegated stop from a stop aimed at
 * that child.
 */
const CASCADED_CANCEL_REASON = "parent_run_cancelled";

export interface CancelTxResult {
  outcome: CancelOutcome;
  /**
   * Everything the committed cancel owes the world outside its transaction,
   * as one closure. Call it exactly once, *after* the enclosing tx commits —
   * every obligation inside publishes user-visible state or touches Redis, so
   * none of it may survive a rollback.
   *
   * Handed back as a closure rather than as the raw ids it was built from
   * because the obligation list only grows: it started at the scratch snapshot,
   * gained a parent wake (ADR-0073), gained staging teardown, and gained client
   * closure (#530/#531 D2). Every time it grew, a caller that had already
   * spelled the previous list out by hand silently stopped being correct. A
   * closure has no version to be behind.
   *
   * Never throws: each obligation is independently best-effort and logged, so a
   * dead Redis can't fail a decision the user already made.
   *
   * A no-op unless `outcome === "cancelled"`.
   */
  afterCommit: () => Promise<void>;
}

/** {@link CancelTxResult.afterCommit} for a cancel that didn't happen. */
async function noCancelObligations(): Promise<void> {}

/**
 * Discharge a committed cancel's post-commit obligations, in user-visible-first
 * order. Built by {@link cancelRunInTx}; reached only through
 * {@link CancelTxResult.afterCommit}.
 */
async function dischargeCancelObligations(args: {
  runId: string;
  reason: string;
  /**
   * Gated `action_stagings` rows the cancel bulk-rejected. Their queued
   * expiry/notification jobs must go too, or they fire later against a decided
   * row and no-op — ghost jobs in Redis.
   */
  rejectedStagingIds: string[];
  /**
   * Parent run woken in-tx because this cancelled run was a sub-agent child it
   * was joining (ADR-0073). Enqueued here, after commit, so the executor sees
   * the runnable row and the boss reads the cancelled (terminal) outcome
   * instead of hanging until its dead-man timer fires. `null` when this run is
   * not an awaited child or its parent had already moved on.
   */
  wokenParentRunId: string | null;
}): Promise<void> {
  // Client closure first: a cancel is a terminal transition outside any step
  // body, so the workflow owes the user's in-flight artifact an ending, and
  // that is the only obligation here they can see. Internally best-effort.
  await finalizeCancelledRun(args.runId, args.reason);
  await dischargeStagingSweep(args);
  try {
    await snapshotScratchToPostgres(args.runId);
  } catch (err) {
    console.warn(
      "[agent] scratchpad snapshot failed for cancelled run",
      args.runId,
      toMessage(err),
    );
  }
  if (args.wokenParentRunId) {
    try {
      await enqueueRun(args.wokenParentRunId);
    } catch (err) {
      console.warn(
        "[agent] failed to enqueue woken parent run; dead-man timer will retry",
        args.wokenParentRunId,
        toMessage(err),
      );
    }
  }
}

/**
 * The staging sweep: reject approval rows that committed after the cancel
 * transaction took its snapshot, then tear down the queued expiry/notification
 * jobs of the rows the cancel bulk-rejected. This is the whole post-commit
 * obligation a cascaded sub-agent child owes (#559b) — a sub-agent declares
 * `closure: { kind: "none" }` and writes scratch into its parent's zone, so
 * there is no client closure and no scratch snapshot to drive for it.
 */
async function dischargeStagingSweep(args: {
  runId: string;
  reason: string;
  rejectedStagingIds: string[];
}): Promise<void> {
  // Sweep again after commit. A step body can stage an approval after the
  // cancel transaction took its snapshot; the executor's terminal guard will
  // roll back its step commit, but the staging row itself is an earlier
  // autocommit. The sweep closes that visibility gap.
  await rejectLateCancelledRunStagings(args.runId, args.reason);
  for (const stagingId of args.rejectedStagingIds) {
    // Guarded per queue, not per staging: the two jobs are independent, so a
    // failure removing one must not leave the other behind as well.
    for (const remove of [removeApprovalNotificationJob, removeApprovalExpiryJob]) {
      try {
        await remove(stagingId);
      } catch (err) {
        console.warn("[agent] staging job teardown failed for", stagingId, toMessage(err));
      }
    }
  }
}

/**
 * Reject approval rows that committed after a run's cancel transaction read
 * them. Also called by the losing executor after its guarded commit observes
 * the cancellation, which closes the later "staged after the post-commit
 * sweep" edge.
 */
export async function rejectLateCancelledRunStagings(
  runId: string,
  reason: string,
): Promise<string[]> {
  try {
    const runRows = await db()
      .select({ status: agentRuns.status, userId: agentRuns.userId })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);
    const run = runRows[0];
    const status = runStatusSchema.safeParse(run?.status);
    if (!run || !status.success || status.data !== "cancelled") return [];

    const now = new Date();
    const rejected = await db()
      .update(actionStagings)
      .set({
        status: "rejected",
        rejectReason: reason,
        decidedAt: now,
        rowVersion: sql`${actionStagings.rowVersion} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(actionStagings.runId, runId),
          eq(actionStagings.status, "pending"),
          eq(actionStagings.requiresApproval, true),
        ),
      )
      .returning({ id: actionStagings.id });
    if (rejected.length > 0) emitReplicachePokes([run.userId]);
    const ids = rejected.map((row) => row.id);
    for (const stagingId of ids) {
      for (const remove of [removeApprovalNotificationJob, removeApprovalExpiryJob]) {
        try {
          await remove(stagingId);
        } catch (err) {
          console.warn("[agent] late staging job teardown failed for", stagingId, toMessage(err));
        }
      }
    }
    return ids;
  } catch (err) {
    console.warn("[agent] late cancelled-run staging sweep failed", runId, toMessage(err));
    return [];
  }
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
  const { outcome, afterCommit } = await db().transaction((tx) => cancelRunInTx(tx, args));
  await afterCommit();
  return outcome;
}

/**
 * The transactional half of {@link cancelRun}, for callers that compose the
 * cancel into a wider transaction (the approvals `cancel_run` decision).
 *
 * The cancel's post-commit obligations come back as
 * {@link CancelTxResult.afterCommit} rather than as a list for the caller to
 * re-derive — see that field. Run it once the enclosing tx commits and the
 * composed cancel is as complete as {@link cancelRun}'s.
 *
 * `opts.obligations` selects which post-commit obligations the returned closure
 * carries. `"full"` (the default, used by {@link cancelRun} and the approvals
 * decision) drives client closure, the staging sweep, the scratch snapshot, and
 * a woken parent enqueue. `"staging_sweep"` is the cascaded-child form — a
 * sub-agent owes no client closure and no scratch snapshot, so it carries only
 * {@link dischargeStagingSweep}.
 */
export async function cancelRunInTx(
  tx: AgentTx,
  args: CancelRunArgs,
  opts: { obligations: "full" | "staging_sweep" } = { obligations: "full" },
): Promise<CancelTxResult> {
  const rows = await tx
    .select({
      id: agentRuns.id,
      userId: agentRuns.userId,
      status: agentRuns.status,
      currentStep: agentRuns.currentStep,
      attempt: agentRuns.attempt,
      metadata: agentRuns.metadata,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, args.runId))
    .for("update");
  const row = rows[0];
  if (!row) return { outcome: "not_found", afterCommit: noCancelObligations };
  const status = runStatusSchema.parse(row.status);

  if (isTerminalStatus(status)) {
    return { outcome: "already_terminal", afterCommit: noCancelObligations };
  }

  const now = new Date();
  await tx
    // drift-ok: FOR UPDATE held since the SELECT above, which returned
    // `already_terminal` under that lock. This is the write the guard protects
    // *against* — it cannot route through it.
    .update(agentRuns)
    .set({
      status: "cancelled",
      // #559b: advance the monotonic cancellation fence so a step that started
      // before this cancel refuses to commit AND the tool-runtime dispatch gate
      // stops issuing new effects the moment it re-reads the fence.
      cancellationGeneration: sql`${agentRuns.cancellationGeneration} + 1`,
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

  // ADR-0073: if this run is a sub-agent child, a parent boss may be parked
  // awaiting it. The cancel above nulled the wake and the terminal-child
  // signal only fires on completed|failed, so without this the parent would
  // hang until the dead-man timer fires (≤6 min). Wake it in-tx — it reads the
  // cancelled (terminal) outcome on resume — and hand the parent id back so
  // the caller enqueues it after commit.
  let wokenParentRunId: string | null = null;
  const sub = readSubAgentMetadata(row.metadata);
  if (sub) {
    const signalOutcome = await signalRunInTx(tx, {
      runId: sub.parentRunId,
      match: { kind: "signal", name: subAgentDoneSignalName(args.runId) },
    });
    if (signalOutcome === "woken") {
      wokenParentRunId = sub.parentRunId;
      // #409: the parent woke because we cancelled the child it was joining;
      // record its sub-agent wait with a `cancelled` outcome. Runs on the
      // caller's tx so the lookup sees the same snapshot.
      await emitSubAgentWaitSpan({
        ex: tx,
        parentRunId: sub.parentRunId,
        childRunId: args.runId,
        outcome: "cancelled",
      });
    }
  }

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
      error: boundAgentRunError(args.reason),
    },
  });
  // #559b: cascade the cancel to every sub-agent child this run spawned. A
  // child is a separate `agent_runs` row with its own fence, so the parent's
  // fence says nothing about it: without this, cancelling a boss leaves its
  // children running and still able to land external effects — the same
  // effect-after-cancel hole the fence closes for the parent's own steps.
  // Runs after the parent's own status write above, so a child's cancel reads
  // its (now terminal) parent in this same snapshot and skips the join wake.
  const childObligations = await cancelSpawnedChildrenInTx(tx, {
    parentRunId: args.runId,
    userId: row.userId,
    reason: args.reason,
    pendingApprovalRejectReason: args.pendingApprovalRejectReason,
  });

  const rejectedStagingIds = rejectedStagings.map((r: { id: string }) => r.id);
  return {
    outcome: "cancelled",
    afterCommit: async () => {
      if (opts.obligations === "full") {
        await dischargeCancelObligations({
          runId: args.runId,
          reason: args.reason,
          rejectedStagingIds,
          wokenParentRunId,
        });
      } else {
        await dischargeStagingSweep({ runId: args.runId, reason: args.reason, rejectedStagingIds });
      }
      // Each child's obligations are its own closure, discharged after this
      // run's. Guarded per child so one child's fault cannot strand another
      // child's sweep.
      for (const discharge of childObligations) {
        try {
          await discharge();
        } catch (err) {
          console.warn("[agent] cascaded child cancel obligations failed", toMessage(err));
        }
      }
    },
  };
}

/**
 * Cancel every non-terminal sub-agent child of a run being cancelled, on the
 * parent's transaction (#559b, amending ADR-0073).
 *
 * Why a cascade at all: the cancellation fence lives on one `agent_runs` row.
 * A child run carries its own fence at generation 0 and its dispatch gate reads
 * only that one, so a parent's cancel is invisible to it. "No new effect after
 * cancel" is only true of the whole delegation tree if the cancel reaches the
 * children the boss spawned to act on its behalf.
 *
 * A cascaded child owes only its staging sweep — see the `staging_sweep`
 * obligations passed to `cancelRunInTx` below. Its `agent.run` frame is
 * published in-tx by that call, and its fence is bumped there too.
 *
 * Recursion terminates on the status guard rather than on a depth limit: each
 * child cancel re-locks its own row and returns `already_terminal` for a run
 * this transaction has already cancelled, so a metadata cycle cannot loop.
 * Sub-agents may not spawn sub-agents today (`spawnSubAgent` refuses), which
 * makes the real depth one — the recursion is what keeps this correct if that
 * ever changes.
 *
 * Returns one `afterCommit` closure per cancelled child, for the parent to
 * discharge after its own. Never re-derive that list: see
 * {@link CancelTxResult.afterCommit}.
 */
async function cancelSpawnedChildrenInTx(
  tx: AgentTx,
  args: {
    parentRunId: string;
    userId: string;
    reason: string;
    pendingApprovalRejectReason: string | undefined;
  },
): Promise<Array<() => Promise<void>>> {
  const children = await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, args.userId),
        subAgentParentRunIdMatches(args.parentRunId),
        runIsNotTerminal(agentRuns.status),
      ),
    )
    // Spawn order, for a deterministic discharge sequence. The order does not
    // carry meaning — each child's obligations are independent — but a stable
    // order makes the cascade reproducible.
    .orderBy(agentRuns.createdAt);

  const obligations: Array<() => Promise<void>> = [];
  for (const child of children) {
    const { outcome, afterCommit } = await cancelRunInTx(
      tx,
      {
        runId: child.id,
        reason: CASCADED_CANCEL_REASON,
        // The user-facing approval reject text stays the parent's: the user
        // decided once, about one run.
        pendingApprovalRejectReason: args.pendingApprovalRejectReason ?? args.reason,
      },
      { obligations: "staging_sweep" },
    );
    if (outcome === "cancelled") obligations.push(afterCommit);
  }
  return obligations;
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
  /** The monotonic cancellation fence (#559b). `cancelRun` increments it once. */
  cancellationGeneration: number;
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
    cancellationGeneration: row.cancellationGeneration,
    output: row.output,
    error: row.error,
  };
}

/**
 * Find run rows that are claimable by the worker pool: pending, runnable, or a
 * deferred row whose retry time arrived, plus running rows whose owning worker's
 * heartbeat has gone stale (presumed dead). The stale window is per-step
 * (ADR-0070 §1.4, Lever A): the SQL selects
 * running candidates at {@link minStaleAfterMs} (the smallest window, so nothing
 * is missed), then each is refined against its precise per-step window via
 * {@link resolveStaleAfterMs}. `leaseRun` re-checks the same window under the
 * row lock, so an over-selected candidate that isn't actually stale is a benign
 * no-op there — this refinement just avoids the wasted enqueue churn. The SQL
 * page is consumed before that refinement, so this function paginates until it
 * has `limit` accepted ids or no candidates remain; otherwise a page full of
 * live long-window rows could hide genuinely-stale rows behind it.
 */
export async function findResumableRunIds(opts: { limit?: number }): Promise<string[]> {
  const limit = opts.limit ?? 100;
  if (limit <= 0) return [];
  const resumable: string[] = [];
  let offset = 0;
  while (resumable.length < limit) {
    const result = await db().execute(sql`
      SELECT id, workflow_slug AS "workflowSlug", current_step AS "currentStep", status,
             EXTRACT(EPOCH FROM (now() - last_checkpoint_at)) * 1000 AS "staleMs"
      FROM agent_runs
      WHERE status IN ('pending', 'runnable')
         OR (status = 'deferred' AND deferred_until <= now())
         OR (status = 'running' AND (
           last_checkpoint_at IS NULL
           OR last_checkpoint_at < (now() - make_interval(secs => ${minStaleAfterMs() / 1000}))
         ))
      ORDER BY last_checkpoint_at NULLS FIRST, id
      LIMIT ${limit}
      OFFSET ${offset}
    `);
    const rows = rowsFromExecute<{
      id: string;
      workflowSlug: string;
      currentStep: string;
      status: string;
      staleMs: number | string | null;
    }>(result);
    if (rows.length === 0) break;
    offset += rows.length;
    for (const row of rows) {
      // Pending/runnable and due deferred rows are claimable; only `running`
      // rows are gated on the per-step stale window.
      if (row.status !== "running") {
        resumable.push(row.id);
        if (resumable.length >= limit) break;
        continue;
      }
      const staleMs =
        row.staleMs == null
          ? null
          : typeof row.staleMs === "string"
            ? Number(row.staleMs)
            : row.staleMs;
      if (staleMs == null || staleMs >= resolveStaleAfterMs(row.workflowSlug, row.currentStep)) {
        resumable.push(row.id);
        if (resumable.length >= limit) break;
      }
    }
  }
  return resumable;
}

/**
 * Heartbeat on a leased run — bumps `last_checkpoint_at` so the resume
 * sweep doesn't yank the run out from under us during a long step. Returns
 * false when the leased attempt no longer owns a running row.
 */
export async function heartbeatRun(runId: string, attempt?: number): Promise<boolean> {
  const conds = [eq(agentRuns.id, runId), eq(agentRuns.status, "running")];
  if (attempt !== undefined) conds.push(eq(agentRuns.attempt, attempt));
  const touched = await db()
    .update(agentRuns)
    .set({ lastCheckpointAt: new Date() })
    .where(and(...conds))
    .returning({ id: agentRuns.id });
  return touched.length > 0;
}
