import { toJsonValue, toMessage } from "@alfred/contracts";
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
  isTerminalStatus,
  runStatusSchema,
  wakeConditionSchema,
  type AgentRunTrigger,
  type ApprovalKind,
  type RunStatus,
  type WakeCondition,
} from "@alfred/contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import { emitReplicachePokes, publishEvent } from "@alfred/assistant/triggers";
import {
  removeApprovalExpiryJob,
  removeApprovalNotificationJob,
} from "@alfred/assistant/tool-runtime";
import { snapshotScratchToPostgres } from "./scratchpad/index";
import { enqueueRun } from "./queue";
import { getWorkflow, listWorkflows, type AgentDbExecutor, type WorkflowInput } from "./registry";
import { resolveWorkflowForRun } from "./resolve-workflow";
import {
  readSubAgentMetadata,
  subAgentDoneSignalName,
  subAgentParentRunIdMatches,
} from "./sub-agent-metadata";
import { startSubAgentWaitSpan, type SubAgentWaitOutcome } from "./runtime-spans";
import { finalizeCancelledRun } from "./terminal-closure";
import { deriveRunOutcome, pokeWorkflowOwner, recordWorkflowLastRun } from "./run-outcome";
import { userAuthoredBriefWorkflow } from "./workflows/user-authored-brief";
import {
  workflowOccurrenceKey,
  type WorkflowOccurrenceIdentity,
} from "@alfred/db/workflow-occurrence";

/**
 * A `running` row silent this long has a dead worker and may be reclaimed. Keep it well above the
 * heartbeat.
 */
export const STALE_RUN_LEASE_MS = 60_000;

/**
 * The step's own `staleAfterMs`, else the default (ADR-0070 §1.4).
 * DB-free, so it is safe inside the `leaseRun` lock.
 * A user-authored slug misses the registry, so fall back to the shared user-authored workflow.
 */
export function resolveStaleAfterMs(workflowSlug: string, stepId: string): number {
  const step = getWorkflow(workflowSlug)?.steps[stepId] ?? userAuthoredBriefWorkflow.steps[stepId];

  return step?.staleAfterMs ?? STALE_RUN_LEASE_MS;
}

/**
 * The smallest stale window of any step. The sweep selects at this floor, then refines per step.
 */
export function minStaleAfterMs(): number {
  let min = STALE_RUN_LEASE_MS;

  for (const wf of listWorkflows()) {
    for (const step of Object.values(wf.steps)) {
      if (step.staleAfterMs !== undefined && step.staleAfterMs < min) {
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
 * Insert a `pending` run; the caller enqueues it. If Redis drops the job, the sweep re-enqueues
 * from the table.
 * A workflow `dedupKey` makes a live duplicate fail with a unique violation (23505).
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
    // A revision-backed run ignores caller overrides, so it runs exactly the revision it names.
    brief = row.brief ?? undefined;
    metadata = {
      ...metadata,
      allowedIntegrations: row.allowedIntegrations,
      allowedTools: row.allowedTools.map((tool) => toJsonValue(tool)),
      requiredCapabilities: row.requiredCapabilities.map((capability) => toJsonValue(capability)),
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
    // SAFETY: workflow state is a plain JSON object.
    state: (initialState as object) ?? {},
    transcript,
    currentStep: workflow.initialStep,
    metadata,
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
 * Persist a run and enqueue it.
 * A deduped existing run is enqueued again; that is safe because the DB lease arbitrates.
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
 * Claim and persist a run in one tx, then enqueue after commit (ADR-0027).
 * `claim` returns `null` when it lost the race. An earlier enqueue would let the worker lease an
 * unseen row.
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

/** Enqueue a run that is already persisted. */
export async function redeliverRun(runId: string): Promise<void> {
  await enqueueRun(runId);
}

/**
 * Insert a chat-turn run in a SAVEPOINT, so a unique violation keeps the outer tx alive.
 * The caller calls `redeliverRun` after commit.
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
  /** Wake only if the wake condition matches. */
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

type AgentTx = DbTransaction;

/** Move a `waiting` run to `runnable` if its wake condition matches. Returns whether it woke. */
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
      // Older HIL wakes have no kind; they were all step approvals.
      const wakeKind = wake.approvalKind ?? "step";

      if (wakeKind !== match.approvalKind) return "wake_mismatch";
    }

    if (match.kind === "signal" && wake.kind === "signal" && wake.name !== match.name) {
      return "wake_mismatch";
    }
  }

  await tx
    // drift-ok: the SELECT above holds the lock and returned unless status is `waiting`.
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
 * Wake the parent that waits on this finished sub-agent (ADR-0073).
 * Returns the parent id if it woke, so the caller can enqueue it. Idempotent.
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
    const outcome = subAgentOutcomeFromStatus(rows[0]?.status);

    if (outcome) {
      await emitSubAgentWaitSpan({ ex: db(), parentRunId: sub.parentRunId, childRunId, outcome });
    }
  }

  return woken ? sub.parentRunId : null;
}

function subAgentOutcomeFromStatus(status: string | undefined): SubAgentWaitOutcome | null {
  if (status === "completed" || status === "failed" || status === "cancelled") return status;

  return null;
}

/**
 * Best-effort wait span for a woken parent (#409). Park time is its last `interrupted` step's
 * `ended_at`.
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
  /** Stored in `agent_runs.error.reason`. */
  reason: string;
  /** User-facing text for approvals rejected with the run. Defaults to `reason`. */
  pendingApprovalRejectReason?: string | undefined;
}

export type CancelOutcome = "cancelled" | "already_terminal" | "not_found";

/** A child's reason when the parent's cancel cascades to it (#559b). */
const CASCADED_CANCEL_REASON = "parent_run_cancelled";

export interface CancelTxResult {
  outcome: CancelOutcome;
  /**
   * The cancel's side effects outside the tx. Call it once, after commit.
   * A closure, so callers cannot drift from a list that keeps growing.
   * Never throws. A no-op unless `outcome === "cancelled"`.
   */
  afterCommit: () => Promise<void>;
}

async function noCancelObligations(): Promise<void> {}

/** Run a committed cancel's side effects, the user-visible one first. */
async function dischargeCancelObligations(args: {
  runId: string;
  reason: string;
  /** Their queued expiry and notification jobs must be removed too. */
  rejectedStagingIds: string[];
  /** A parent woken in the tx; enqueue it after commit so it sees the runnable row. */
  wokenParentRunId: string | null;
}): Promise<void> {
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
 * Reject stagings that committed after the cancel's snapshot, then remove the queued jobs.
 * A cascaded sub-agent owes only this (#559b).
 */
async function dischargeStagingSweep(args: {
  runId: string;
  reason: string;
  rejectedStagingIds: string[];
}): Promise<void> {
  // A step body can autocommit a staging after the cancel's snapshot; the guard cannot roll that
  // back.
  await rejectLateCancelledRunStagings(args.runId, args.reason);

  for (const stagingId of args.rejectedStagingIds) {
    // Per queue, so one failure does not leave the other job behind.
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
 * Reject stagings that committed after the cancel tx read them.
 * The losing executor calls it too, for a staging that lands after the post-commit sweep.
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

/** Cancel a non-terminal run. Idempotent: a terminal run reports `already_terminal`. */
export async function cancelRun(args: CancelRunArgs): Promise<CancelOutcome> {
  const { outcome, afterCommit } = await db().transaction((tx) => cancelRunInTx(tx, args));
  await afterCommit();

  return outcome;
}

/**
 * {@link cancelRun} inside the caller's tx. Call `afterCommit` after commit.
 * `"staging_sweep"` is for a cascaded sub-agent, which has no client closure or scratch snapshot.
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
      workflowSlug: agentRuns.workflowSlug,
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
  // Read the effect ledger before the sweep below rejects pending stagings (#561).
  const runOutcome = await deriveRunOutcome(tx, row, { status: "cancelled" });
  await tx
    // drift-ok: the SELECT above holds the lock; this is the write the guard protects against.
    .update(agentRuns)
    .set({
      status: "cancelled",
      // The fence (#559b): an older step cannot commit and the dispatch gate stops new effects.
      cancellationGeneration: sql`${agentRuns.cancellationGeneration} + 1`,
      // A late signal must not match.
      wakeCondition: null,
      error: { message: args.reason, reason: args.reason },
      outcome: runOutcome,
      endedAt: now,
      lastCheckpointAt: now,
      updatedAt: now,
    })
    .where(eq(agentRuns.id, args.runId));
  await recordWorkflowLastRun(tx, row, "cancelled", now);

  // A parent waiting on this sub-agent would otherwise hang until its dead-man timer (ADR-0073).
  let wokenParentRunId: string | null = null;
  const sub = readSubAgentMetadata(row.metadata);

  if (sub) {
    const signalOutcome = await signalRunInTx(tx, {
      runId: sub.parentRunId,
      match: { kind: "signal", name: subAgentDoneSignalName(args.runId) },
    });

    if (signalOutcome === "woken") {
      wokenParentRunId = sub.parentRunId;
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

  // Each child has its own fence, so cancel the children too (#559b).
  // After the parent's write, so a child sees its parent terminal and skips the join wake.
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
      pokeWorkflowOwner(row);

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

      // Per child, so one fault does not strand another child's sweep.
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
 * Cancel each live sub-agent child on the parent's tx (#559b).
 * The status guard ends the recursion, so a metadata cycle cannot loop.
 * Returns one `afterCommit` per child.
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
    // Stable order only, for reproducible runs.
    .orderBy(agentRuns.createdAt);

  const obligations: Array<() => Promise<void>> = [];

  for (const child of children) {
    const { outcome, afterCommit } = await cancelRunInTx(
      tx,
      {
        runId: child.id,
        reason: CASCADED_CANCEL_REASON,
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
  /** Cancel increments it (#559b). */
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
 * Ids the worker pool can claim: pending, runnable, due deferred, and stale `running` rows.
 * SQL selects at the smallest stale window, then each row is refined per step.
 * It pages until `limit`, so live long-window rows cannot hide stale ones.
 */
export async function findResumableRunIds(opts: { limit?: number }): Promise<string[]> {
  return collectResumableRunIds(opts.limit ?? 100, readResumeSweepPage);
}

export type ResumeSweepCandidate = {
  readonly id: string;
  readonly workflowSlug: string;
  readonly currentStep: string;
  readonly status: string;
  readonly staleMs: number | string | null;
};

async function readResumeSweepPage(page: {
  limit: number;
  offset: number;
}): Promise<ResumeSweepCandidate[]> {
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
    LIMIT ${page.limit}
    OFFSET ${page.offset}
  `);

  return rowsFromExecute<ResumeSweepCandidate>(result);
}

/**
 * The page loop, with the reader injected: the real query reads every user's rows, so a shared test
 * DB races.
 */
export async function collectResumableRunIds(
  limit: number,
  readPage: (page: { limit: number; offset: number }) => Promise<readonly ResumeSweepCandidate[]>,
): Promise<string[]> {
  if (limit <= 0) return [];
  const resumable: string[] = [];
  let offset = 0;

  while (resumable.length < limit) {
    const rows = await readPage({ limit, offset });

    if (rows.length === 0) break;
    offset += rows.length;

    for (const row of rows) {
      if (row.status !== "running") {
        resumable.push(row.id);

        if (resumable.length >= limit) break;
        continue;
      }

      const staleMs = row.staleMs == null ? null : Number(row.staleMs);

      if (staleMs == null || staleMs >= resolveStaleAfterMs(row.workflowSlug, row.currentStep)) {
        resumable.push(row.id);

        if (resumable.length >= limit) break;
      }
    }
  }

  return resumable;
}

/** Bump `last_checkpoint_at` on a leased run. Returns false when this attempt lost the run. */
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
