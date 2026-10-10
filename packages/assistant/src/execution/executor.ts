import type { AgentRunError, AgentTranscriptMessage } from "@alfred/contracts";
import {
  AGENT_PROGRESS_MESSAGE_MAX,
  AGENT_STEP_PROGRESS_STATUSES,
  boundAgentRunError,
  isTerminalStatus,
  sanitizeErrorMessage,
  sanitizeToolResult,
  toMessage,
  type RunStatus,
  type WakeCondition,
} from "@alfred/contracts";
import { db, rowsFromExecute, type DbTransaction } from "@alfred/db";
import { logger } from "@alfred/logging";
import {
  agentDecisionTraces,
  agentRuns,
  agentSteps,
  pendingActions,
  type AgentRun,
} from "@alfred/db/schemas";
import { runStatusSchema } from "@alfred/contracts";
import { and, eq, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { publishEvent } from "@alfred/assistant/triggers";
import { normalizeDecisionTraceKey, type DecisionTraceBase } from "./decision-traces";
import { resolveWorkflowForRun } from "./resolve-workflow";
import { rejectLateCancelledRunStagings, resolveStaleAfterMs } from "./service";
import { finalizeFailedRun } from "./terminal-closure";
import { deriveRunOutcome, pokeWorkflowOwner, recordWorkflowLastRun } from "./run-outcome";
import { isUniqueViolation } from "@alfred/db/pg-errors";
import { startQueueLeaseSpan, type QueueLeaseFromStatus } from "./runtime-spans";
import type { StagedAction, Step, StepContext, StepResult, Workflow } from "./registry";

/**
 * A step reclaimed this many times since its last commit fails the run (ADR-0070 §1.4).
 * The first reclaim is free, so a real worker death still recovers.
 */
const BACKSTOP_RECLAIM_LIMIT = 3;

/**
 * Why this worker no longer owns the run:
 * `reclaim` means a stale-lease reclaim bumped `attempt`;
 * `terminal` means a cancel landed during the step body (#530).
 */
export type SupersedeCause = "reclaim" | "terminal";

const SUPERSEDE_SKIP_REASON = {
  reclaim: "superseded_by_reclaim",
  terminal: "run_already_terminal",
} as const satisfies Record<SupersedeCause, string>;

/** Reasons `runOnce` reports a benign skip: nothing ran, nothing to re-enqueue. */
export type RunSkipReason =
  | "no_lease"
  | "step_already_committed"
  | (typeof SUPERSEDE_SKIP_REASON)[SupersedeCause];

/**
 * Which skips the worker logs. A new skip reason fails this `satisfies` until it picks one.
 * Supersedes are loud: two workers called the model for one step, and the bill is the only other
 * trace.
 * The quiet ones are routine races and re-delivered jobs.
 */
const SKIP_REASON_VOLUME = {
  no_lease: "quiet",
  step_already_committed: "quiet",
  superseded_by_reclaim: "loud",
  run_already_terminal: "loud",
} as const satisfies Record<RunSkipReason, "loud" | "quiet">;

export function skipReasonIsLoud(reason: RunSkipReason): boolean {
  return SKIP_REASON_VOLUME[reason] === "loud";
}

/**
 * Thrown in a commit tx when this worker lost the run. It rolls back the whole commit,
 * so a cancelled run is not resurrected and no `approval.requested` fires.
 * The worker holds no row lock during the step body, so only this guard stops a mid-step cancel.
 * It cannot un-bill the model call that already ran.
 */
class RunSupersededError extends Error {
  readonly supersedeCause: SupersedeCause;
  constructor(runId: string, stepId: string, attempt: number, supersedeCause: SupersedeCause) {
    super(
      supersedeCause === "terminal"
        ? `run ${runId} step ${stepId} attempt ${attempt} reached a terminal status before commit`
        : `run ${runId} step ${stepId} attempt ${attempt} superseded by reclaim before commit`,
    );
    this.name = "RunSupersededError";
    this.supersedeCause = supersedeCause;
  }
}

/**
 * Return `null` if this worker still owns the run, else why not.
 * One `SELECT ... FOR UPDATE`: the lock makes the status read here the one the write lands on.
 * `reclaim` wins a tie with `terminal` because it is the more actionable signal.
 *
 * Known deadlock: commits lock `agent_steps` then `agent_runs`; `leaseRun`'s reclaim locks the
 * reverse.
 * A 40P01 rolls back and BullMQ retries, so it is noisy but safe.
 * Moving this guard earlier would let a commit beat a mid-commit cancel, so do not just reorder.
 */
async function guardRunOwnership(
  tx: DbTransaction,
  runId: string,
  attempt: number,
  expectedGeneration: number,
): Promise<SupersedeCause | null> {
  const rows = await tx
    .select({
      status: agentRuns.status,
      attempt: agentRuns.attempt,
      cancellationGeneration: agentRuns.cancellationGeneration,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .for("update");

  const row = rows[0];

  if (!row) return "reclaim";

  if (row.attempt !== attempt) return "reclaim";

  // Cancel bumps the generation (#559b); a step started under an older one must not commit.
  if (row.cancellationGeneration !== expectedGeneration) return "terminal";
  const status = runStatusSchema.safeParse(row.status);

  // An unknown status counts as terminal, so the worker skips instead of retrying forever.
  return !status.success || isTerminalStatus(status.data) ? "terminal" : null;
}

/**
 * Every executor status write on `agent_runs` goes through here: lock the row,
 * throw {@link RunSupersededError} if this worker lost the run, then apply `set`.
 * Only `leaseRun` skips it, because it already holds the row lock.
 */
async function commitGuardedRunUpdate(
  tx: DbTransaction,
  run: RunRow,
  stepId: string,
  attempt: number,
  set: PgUpdateSetSource<typeof agentRuns>,
): Promise<void> {
  const cause = await guardRunOwnership(tx, run.id, attempt, run.cancellationGeneration);

  if (cause) throw new RunSupersededError(run.id, stepId, attempt, cause);
  await tx.update(agentRuns).set(set).where(eq(agentRuns.id, run.id));
}

/** The step identity a side effect outside the commit fences on. `StepContext` satisfies it. */
export type StepLease = Pick<StepContext<unknown>, "runId" | "attempt" | "fence">;

/**
 * Run `write` in one transaction that first locks the run row with the commit's own predicate.
 * Returns the cause and runs nothing when this attempt no longer owns the run, so a body whose
 * lease was reclaimed cannot write over the live attempt.
 * Lock order is `agent_runs` then the caller's tables, the same as `leaseRun`.
 * It opens its own transaction, so the caller must not hold the `agent_runs` row lock in an
 * outer transaction: the inner lock would wait on it.
 */
export async function withStepLease<T>(
  lease: StepLease,
  write: (tx: DbTransaction) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; cause: SupersedeCause }> {
  return await db().transaction(async (tx) => {
    const cause = await guardRunOwnership(tx, lease.runId, lease.attempt, lease.fence.generation);

    if (cause) return { ok: false, cause };

    return { ok: true, value: await write(tx) };
  });
}

/**
 * The one builder for the executor's `agent.run` failed frame (ADR-0073).
 * `tx` is required so a cancel that rolls back the status write also drops this frame.
 * `error` is already bounded, so this does not sanitize again.
 */
async function publishRunFailed(
  tx: DbTransaction,
  fields: { userId: string; runId: string; step: string; attempt: number; error: AgentRunError },
): Promise<void> {
  await publishEvent({
    tx,
    userId: fields.userId,
    kind: "agent.run",
    payload: {
      runId: fields.runId,
      phase: "failed",
      step: fields.step,
      attempt: fields.attempt,
      error: fields.error,
    },
  });
}

/** What `runOnce` tells the worker: re-enqueue on `advanced`, else stop. */
export type RunOutcome =
  | { kind: "advanced"; runId: string; nextStep: string }
  | { kind: "completed"; runId: string }
  | { kind: "interrupted"; runId: string; wake: WakeCondition }
  | { kind: "deferred"; runId: string; retryAt: Date }
  | { kind: "blocked"; runId: string }
  | { kind: "failed"; runId: string; error: string }
  | { kind: "skipped"; runId: string; reason: RunSkipReason };

/**
 * `backstopped`: the lease tx already failed the run (ADR-0070 §1.4);
 * the caller must still drive workflow failure closure.
 */
export type LeaseResult =
  | { kind: "leased"; run: RunRow; attempt: number; queue: LeaseQueueInfo }
  | { kind: "backstopped"; run: RunRow; error: string; queue: LeaseQueueInfo }
  | { kind: "none" };

/** Queue timing from the lease, so the span is emitted outside the `FOR UPDATE` tx (#409). */
interface LeaseQueueInfo {
  /** Null when the row was never checkpointed. */
  staleMs: number | null;
  fromStatus: QueueLeaseFromStatus;
  reclaimed: boolean;
}

type RunRow = Omit<
  Pick<
    AgentRun,
    | "id"
    | "userId"
    | "workflowSlug"
    | "status"
    | "state"
    | "transcript"
    | "currentStep"
    | "attempt"
    | "cancellationGeneration"
    | "metadata"
    | "deferredUntil"
  >,
  "status"
> & {
  status: RunStatus;
};

export interface RunOnceOptions {
  /** Runs just before the step body, so the worker heartbeats only its own attempt. */
  onLeased?: (lease: { runId: string; stepId: string; attempt: number }) => void;
}

/**
 * Run one step and commit its result atomically.
 * Safe to re-run after a crash: the same `(runId, stepId, attempt)` no-ops.
 */
export async function runOnce(runId: string, opts: RunOnceOptions = {}): Promise<RunOutcome> {
  const leased = await leaseRun(runId);

  if (leased.kind === "none") {
    return { kind: "skipped", runId, reason: "no_lease" };
  }

  // No step body ran, so drive the workflow's failure closure here.
  if (leased.kind === "backstopped") {
    pokeWorkflowOwner(leased.run);
    await finalizeFailedRun(leased.run, leased.error);

    return { kind: "failed", runId, error: leased.error };
  }

  const { run, attempt } = leased;
  const stepId = run.currentStep;
  const idempotencyKey = `${run.id}:${stepId}:${attempt}`;

  startQueueLeaseSpan({
    runId: run.id,
    workflow: run.workflowSlug,
    stepId,
    fromStatus: leased.queue.fromStatus,
    reclaimed: leased.queue.reclaimed,
    queueMs: leased.queue.staleMs,
    leasedAt: new Date(),
  }).end();

  // A deploy that dropped the workflow or step must fail the run, not leave a zombie.
  let workflow: Workflow<unknown>;
  let step: Step<unknown>;

  try {
    workflow = (
      await resolveWorkflowForRun({
        userId: run.userId,
        workflowSlug: run.workflowSlug,
      })
    ).workflow;
    step = requireStep(workflow, stepId);
  } catch (err) {
    const error = toMessage(err);
    // A cancel can land before this point; then the cancel path owns closure.
    const superseded = await markRunFailed(run, stepId, attempt, error);

    if (superseded) {
      return { kind: "skipped", runId: run.id, reason: SUPERSEDE_SKIP_REASON[superseded] };
    }

    await finalizeFailedRun(run, sanitizeErrorMessage(error));

    return { kind: "failed", runId: run.id, error };
  }

  const inserted = await tryInsertStepRow(run.id, stepId, attempt, run.state);

  if (!inserted) {
    return { kind: "skipped", runId: run.id, reason: "step_already_committed" };
  }

  opts.onLeased?.({ runId: run.id, stepId, attempt });

  await publishEvent({
    untransacted: true,
    userId: run.userId,
    kind: "agent.run",
    payload: { runId: run.id, phase: "step_started", step: stepId, attempt },
  });

  // The step body runs outside the tx; `stageAction` defers side effects to the commit.
  const staged: StagedAction[] = [];
  const traces: DecisionTraceBase[] = [];
  const seenTraceKeys = new Set<string>();

  const ctx: StepContext<unknown> = {
    runId: run.id,
    userId: run.userId,
    idempotencyKey,
    attempt,
    fence: { generation: run.cancellationGeneration },
    state: run.state,
    transcript: run.transcript,
    stageAction(action) {
      staged.push(action);
    },
    async log(message) {
      try {
        await publishEvent({
          untransacted: true,
          userId: run.userId,
          kind: "agent.progress",
          payload: {
            runId: run.id,
            step: stepId,
            message: sanitizeErrorMessage(message, AGENT_PROGRESS_MESSAGE_MAX),
          },
        });
      } catch (err) {
        // A lost progress frame costs nothing (ADR-0005), so a publish fault never fails the step.
        // Only the publish fault goes under `err`; the message text can hold user data. (A drizzle
        // `err.message` echoes the query params in dev; production drops `err.message`.)
        logger.warn(
          {
            err,
            event: "agent_progress_publish_fault",
            runId: run.id,
            step: stepId,
            messageLength: message.length,
          },
          "agent: progress frame lost",
        );
      }
    },
    trace(kind, record, options) {
      const decisionKey = normalizeDecisionTraceKey(options?.decisionKey);
      const slot = `${kind}\u0000${decisionKey}`;

      if (seenTraceKeys.has(slot)) {
        throw new Error(
          `[agent] duplicate decision trace kind=${kind} decisionKey=${decisionKey} in step=${stepId}`,
        );
      }

      seenTraceKeys.add(slot);
      traces.push({ kind, decisionKey, record });
    },
  };

  let result: StepResult<unknown>;

  try {
    result = await step.run(ctx);
  } catch (err) {
    const error = toMessage(err);
    const outcome = await commitStepFailure(run, stepId, attempt, error);

    if (outcome.kind === "failed") {
      await finalizeFailedRun(run, outcome.error, err);
    }

    return outcome;
  }

  return await commitStepSuccess(run, stepId, attempt, result, staged, traces);
}

/** Exported for tests only; `runOnce` is the production caller. */
export async function leaseRun(runId: string): Promise<LeaseResult> {
  return await db().transaction(async (tx) => {
    const result = await tx.execute(sql`
      SELECT id, user_id AS "userId", workflow_slug AS "workflowSlug", status,
             state, transcript, current_step AS "currentStep", attempt, metadata,
             cancellation_generation AS "cancellationGeneration",
             deferred_until AS "deferredUntil",
             EXTRACT(EPOCH FROM (now() - last_checkpoint_at)) * 1000 AS "staleMs"
      FROM agent_runs
      WHERE id = ${runId}
      FOR UPDATE SKIP LOCKED
    `);

    const row = rowsFromExecute<RunRow & { staleMs: number | string | null }>(result)[0];

    if (!row) return { kind: "none" };

    const status = runStatusSchema.parse(row.status);

    if (isTerminalStatus(status)) return { kind: "none" };

    if (status === "waiting") return { kind: "none" }; // a signal flips it to runnable first

    if (status === "deferred" && row.deferredUntil && row.deferredUntil > new Date()) {
      return { kind: "none" };
    }

    // A `running` row with a stale heartbeat has a dead worker: reclaim it and bump
    // `attempt` so the new step row does not collide with the orphan.
    const staleMs = row.staleMs == null ? null : Number(row.staleMs);

    let isStaleRunning = false;

    if (status === "running") {
      // Long model steps declare a wider window (ADR-0070 §1.4).
      const staleAfterMs = resolveStaleAfterMs(row.workflowSlug, row.currentStep);

      if (staleMs == null || staleMs >= staleAfterMs) {
        isStaleRunning = true;
      } else {
        return { kind: "none" }; // a live worker holds it
      }
    }

    // Backstop (ADR-0070 §1.4): a step that can never commit would be reclaimed forever.
    // Count reclaims since its last commit by the structured `reason`, not the message text.
    if (isStaleRunning) {
      const countResult = await tx.execute(sql`
        SELECT count(*)::int AS "reclaims"
        FROM agent_steps
        WHERE run_id = ${row.id}
          AND step_id = ${row.currentStep}
          AND status = 'failed'
          AND error->>'reason' = 'lease_reclaimed'
          AND attempt > COALESCE(
            (SELECT max(attempt) FROM agent_steps
             WHERE run_id = ${row.id}
               AND step_id = ${row.currentStep}
               -- Every status in AGENT_STEP_PROGRESS_STATUSES proves a commit:
               -- completed advanced/finished; interrupted parked for HIL/wake;
               -- deferred parked under a bounded retry policy. A reclaim after
               -- any of them must NOT count toward the backstop limit.
               AND status IN (${sql.raw(
                 AGENT_STEP_PROGRESS_STATUSES.map((status) => `'${status}'`).join(", "),
               )})),
            -1
          )
      `);

      const priorReclaims = rowsFromExecute<{ reclaims: number }>(countResult)[0]?.reclaims ?? 0;

      if (priorReclaims + 1 >= BACKSTOP_RECLAIM_LIMIT) {
        const now = new Date();

        const backstopError = boundAgentRunError(
          `step ${row.currentStep} not progressing: reclaimed ${priorReclaims + 1} times`,
        );

        await tx
          .update(agentSteps)
          .set({
            status: "failed",
            error: {
              message: backstopError,
              reason: "lease_reclaimed",
            },
            endedAt: now,
          })
          .where(
            and(
              eq(agentSteps.runId, row.id),
              eq(agentSteps.stepId, row.currentStep),
              eq(agentSteps.attempt, row.attempt),
              eq(agentSteps.status, "running"),
            ),
          );

        // Use the synthetic message, never the original error: a poisoned error
        // would make this write throw too, and the run would outlive its backstop.
        const backstopOutcome = await deriveRunOutcome(tx, row, {
          status: "failed",
          code: "non_progressing",
          safeMessage: backstopError,
        });

        await tx
          // drift-ok: FOR UPDATE held since this tx's SELECT, status checked under it.
          .update(agentRuns)
          .set({
            status: "failed",
            error: {
              message: backstopError,
              step: row.currentStep,
              attempt: row.attempt,
            },
            outcome: backstopOutcome,
            endedAt: now,
            lastCheckpointAt: now,
            updatedAt: now,
          })
          .where(eq(agentRuns.id, row.id));
        await recordWorkflowLastRun(tx, row, "failed", now);
        await publishRunFailed(tx, {
          userId: row.userId,
          runId: row.id,
          step: row.currentStep,
          attempt: row.attempt,
          error: backstopError,
        });

        return {
          kind: "backstopped",
          run: { ...row, status, attempt: row.attempt },
          error: backstopError,
          queue: { staleMs, fromStatus: "running", reclaimed: true },
        };
      }
    }

    const attempt = isStaleRunning ? row.attempt + 1 : row.attempt;

    if (isStaleRunning) {
      await tx
        .update(agentSteps)
        .set({
          status: "failed",
          error: {
            message: "lease reclaimed: previous worker presumed dead",
            reason: "lease_reclaimed",
          },
          endedAt: new Date(),
        })
        .where(
          and(
            eq(agentSteps.runId, row.id),
            eq(agentSteps.stepId, row.currentStep),
            eq(agentSteps.attempt, row.attempt),
            eq(agentSteps.status, "running"),
          ),
        );
    }

    await tx
      // drift-ok: this is the lease; the SELECT above holds the lock and rejected terminal rows.
      .update(agentRuns)
      .set({
        status: "running",
        attempt,
        deferredUntil: null,
        startedAt: status === "pending" ? new Date() : undefined,
        lastCheckpointAt: new Date(),
      })
      .where(eq(agentRuns.id, runId));

    if (status === "pending") {
      await publishEvent({
        tx,
        userId: row.userId,
        kind: "agent.run",
        payload: { runId: row.id, phase: "started", workflowSlug: row.workflowSlug },
      });
    }

    // SAFETY: the branches above leave only pending, runnable, running, or deferred.
    const queue: LeaseQueueInfo = {
      staleMs,
      fromStatus: status as QueueLeaseFromStatus,
      reclaimed: isStaleRunning,
    };

    return { kind: "leased", run: { ...row, status, attempt }, attempt, queue };
  });
}

function requireStep<S>(workflow: Workflow<S>, stepId: string): Step<S> {
  const step = workflow.steps[stepId];

  if (!step) {
    throw new Error(`[agent] workflow=${workflow.slug} has no step=${stepId}; deploy mismatch?`);
  }

  return step;
}

/**
 * Return false if this `(runId, stepId, attempt)` row exists: an earlier delivery already ran it.
 */
async function tryInsertStepRow(
  runId: string,
  stepId: string,
  attempt: number,
  state: unknown,
): Promise<boolean> {
  try {
    await db()
      .insert(agentSteps)
      .values({
        runId,
        stepId,
        attempt,
        status: "running",
        // SAFETY: workflow state is a JSON tree for the jsonb column.
        input: state as object,
      });

    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/** Exported for tests only; `runOnce` is the production caller. */
export async function commitStepSuccess(
  run: RunRow,
  stepId: string,
  attempt: number,
  result: StepResult<unknown>,
  staged: StagedAction[],
  traces: DecisionTraceBase[],
): Promise<RunOutcome> {
  // Model output can carry U+0000 or a lone surrogate that jsonb rejects (ADR-0070 §1.1).
  // A throw here would strand a run whose chat message already says `complete`.
  const cleanState = sanitizeToolResult(result.state).value;

  const cleanTranscript =
    result.transcript === undefined ? undefined : sanitizeToolResult(result.transcript).value;

  const cleanOutput =
    result.kind === "done" || result.kind === "blocked" || result.kind === "defer"
      ? sanitizeToolResult(result.output ?? null).value
      : null;

  const cleanWake = result.kind === "interrupt" ? sanitizeToolResult(result.wake).value : undefined;

  try {
    const outcome = await commitStepSuccessTx(
      run,
      stepId,
      attempt,
      result,
      staged,
      traces,
      cleanState,
      cleanTranscript,
      cleanOutput,
      cleanWake,
    );

    // The owner's synced workflow list is stale until poked (#561).
    if (outcome.kind === "completed" || outcome.kind === "blocked") pokeWorkflowOwner(run);

    return outcome;
  } catch (err) {
    // The commit rolled back. Do not re-enqueue: the reclaimer owns the run, or nobody does.
    if (err instanceof RunSupersededError) {
      if (err.supersedeCause === "terminal") {
        await rejectLateCancelledRunStagings(run.id, "run cancelled before step commit");
      }

      return { kind: "skipped", runId: run.id, reason: SUPERSEDE_SKIP_REASON[err.supersedeCause] };
    }

    throw err;
  }
}

async function commitStepSuccessTx(
  run: RunRow,
  stepId: string,
  attempt: number,
  result: StepResult<unknown>,
  staged: StagedAction[],
  traces: DecisionTraceBase[],
  cleanState: unknown,
  cleanTranscript: AgentTranscriptMessage[] | undefined,
  cleanOutput: unknown,
  cleanWake: WakeCondition | undefined,
): Promise<RunOutcome> {
  return await db().transaction(async (tx) => {
    const now = new Date();

    await tx
      .update(agentSteps)
      .set({
        status:
          result.kind === "interrupt"
            ? "interrupted"
            : result.kind === "defer"
              ? "deferred"
              : result.kind === "blocked"
                ? "blocked"
                : "completed",
        output: cleanOutput,
        endedAt: now,
      })
      .where(
        and(
          eq(agentSteps.runId, run.id),
          eq(agentSteps.stepId, stepId),
          eq(agentSteps.attempt, attempt),
        ),
      );

    // The unique `idempotency_key` drops a re-staged action on a re-attempt.
    for (const action of staged) {
      const key = action.idempotencyKey ?? `${run.id}:${stepId}:${attempt}:${action.kind}`;

      try {
        await tx.insert(pendingActions).values({
          runId: run.id,
          stepId,
          attempt,
          kind: action.kind,
          payload: sanitizeToolResult(action.payload).value,
          idempotencyKey: key,
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }

    if (traces.length > 0) {
      await tx
        .insert(agentDecisionTraces)
        .values(
          traces.map((t) => ({
            runId: run.id,
            userId: run.userId,
            workflowSlug: run.workflowSlug,
            stepId,
            attempt,
            kind: t.kind,
            decisionKey: t.decisionKey,
            trace: sanitizeToolResult(t.record).value,
          })),
        )
        .onConflictDoNothing();
    }

    if (result.kind === "next") {
      await commitGuardedRunUpdate(tx, run, stepId, attempt, {
        // SAFETY: sanitize preserves the state's JSON shape for the jsonb column.
        state: cleanState as object,
        currentStep: result.nextStep,
        // Never reset: a loop back into an earlier step would collide with its old step row
        // and stall until the stale-lease sweep. `attempt` is not a retry cap.
        attempt: attempt + 1,
        status: "runnable",
        lastCheckpointAt: now,
        updatedAt: now,
        ...(cleanTranscript === undefined ? {} : { transcript: cleanTranscript }),
      });

      await publishEvent({
        tx,
        userId: run.userId,
        kind: "agent.run",
        payload: { runId: run.id, phase: "step_completed", step: stepId, attempt },
      });

      return { kind: "advanced", runId: run.id, nextStep: result.nextStep };
    }

    if (result.kind === "done") {
      const outcome = await deriveRunOutcome(tx, run, {
        status: "completed",
        summary: result.summary,
      });

      await commitGuardedRunUpdate(tx, run, stepId, attempt, {
        // SAFETY: sanitize preserves the state's JSON shape for the jsonb column.
        state: cleanState as object,
        status: "completed",
        output: cleanOutput,
        outcome,
        endedAt: now,
        lastCheckpointAt: now,
        updatedAt: now,
        ...(cleanTranscript === undefined ? {} : { transcript: cleanTranscript }),
      });
      await recordWorkflowLastRun(tx, run, "completed", now);

      await publishEvent({
        tx,
        userId: run.userId,
        kind: "agent.run",
        payload: { runId: run.id, phase: "completed", step: stepId, attempt },
      });

      return { kind: "completed", runId: run.id };
    }

    if (result.kind === "blocked") {
      const outcome = await deriveRunOutcome(tx, run, { status: "blocked", output: cleanOutput });
      await commitGuardedRunUpdate(tx, run, stepId, attempt, {
        // SAFETY: sanitize preserves the state's JSON shape for the jsonb column.
        state: cleanState as object,
        status: "blocked",
        output: cleanOutput,
        outcome,
        endedAt: now,
        lastCheckpointAt: now,
        updatedAt: now,
        ...(cleanTranscript === undefined ? {} : { transcript: cleanTranscript }),
      });
      await recordWorkflowLastRun(tx, run, "blocked", now);
      await publishEvent({
        tx,
        userId: run.userId,
        kind: "agent.run",
        payload: {
          runId: run.id,
          phase: "blocked",
          step: stepId,
          attempt,
          workflowSlug: run.workflowSlug,
          error: boundAgentRunError("Workflow blocked: action is required."),
        },
      });

      return { kind: "blocked", runId: run.id };
    }

    if (result.kind === "defer") {
      // A deferred run is not over, so no `last_run_*` roll-up.
      const outcome = await deriveRunOutcome(tx, run, {
        status: "deferred",
        reason: result.reason,
        retryAt: result.retryAt,
      });

      await commitGuardedRunUpdate(tx, run, stepId, attempt, {
        // SAFETY: sanitize preserves the state's JSON shape for the jsonb column.
        state: cleanState as object,
        status: "deferred",
        output: cleanOutput,
        outcome,
        deferredUntil: result.retryAt,
        attempt: attempt + 1,
        lastCheckpointAt: now,
        updatedAt: now,
        ...(cleanTranscript === undefined ? {} : { transcript: cleanTranscript }),
      });
      await publishEvent({
        tx,
        userId: run.userId,
        kind: "agent.run",
        payload: {
          runId: run.id,
          phase: "deferred",
          step: stepId,
          attempt,
          retryAt: result.retryAt.toISOString(),
        },
      });

      return { kind: "deferred", runId: run.id, retryAt: result.retryAt };
    }

    const wake = cleanWake!;
    await commitGuardedRunUpdate(tx, run, stepId, attempt, {
      // SAFETY: sanitize preserves the state's JSON shape for the jsonb column.
      state: cleanState as object,
      status: "waiting",
      wakeCondition: wake,
      attempt: attempt + 1, // next attempt of the same step on resume
      lastCheckpointAt: now,
      updatedAt: now,
      ...(cleanTranscript === undefined ? {} : { transcript: cleanTranscript }),
    });

    if (wake.kind === "hil") {
      await publishEvent({
        tx,
        userId: run.userId,
        kind: "approval.requested",
        payload: {
          runId: run.id,
          approvalId: wake.approvalId,
          // Older HIL wakes have no kind.
          approvalKind: wake.approvalKind ?? "step",
          prompt: wake.prompt ?? "Approval requested",
        },
      });
    }

    await publishEvent({
      tx,
      userId: run.userId,
      kind: "agent.run",
      payload: {
        runId: run.id,
        phase: "interrupted",
        step: stepId,
        attempt,
        wake,
      },
    });

    return { kind: "interrupted", runId: run.id, wake };
  });
}

async function commitStepFailure(
  run: RunRow,
  stepId: string,
  attempt: number,
  error: string,
): Promise<RunOutcome> {
  // A NUL byte or an over-cap message would make the failed write throw and loop
  // the run through reclaims (ADR-0070 §1.3, §8). Bound it once for the row and the frame.
  const safeError = boundAgentRunError(error);

  try {
    await db().transaction(async (tx) => {
      const now = new Date();
      await tx
        .update(agentSteps)
        .set({
          status: "failed",
          error: { message: safeError },
          endedAt: now,
        })
        .where(
          and(
            eq(agentSteps.runId, run.id),
            eq(agentSteps.stepId, stepId),
            eq(agentSteps.attempt, attempt),
          ),
        );

      const outcome = await deriveRunOutcome(tx, run, {
        status: "failed",
        code: "step_failed",
        safeMessage: safeError,
      });

      await commitGuardedRunUpdate(tx, run, stepId, attempt, {
        status: "failed",
        error: { message: safeError, step: stepId, attempt },
        outcome,
        endedAt: now,
        lastCheckpointAt: now,
        updatedAt: now,
      });
      await recordWorkflowLastRun(tx, run, "failed", now);

      await publishRunFailed(tx, {
        userId: run.userId,
        runId: run.id,
        step: stepId,
        attempt,
        error: safeError,
      });
    });
  } catch (err) {
    // Do not write `failed` over a cancel (#530).
    if (err instanceof RunSupersededError) {
      if (err.supersedeCause === "terminal") {
        await rejectLateCancelledRunStagings(run.id, "run cancelled before step commit");
      }

      return { kind: "skipped", runId: run.id, reason: SUPERSEDE_SKIP_REASON[err.supersedeCause] };
    }

    throw err;
  }

  pokeWorkflowOwner(run);

  return { kind: "failed", runId: run.id, error: safeError };
}

/**
 * Fail a run whose workflow or step did not resolve, so there is no step row.
 * Returns the {@link SupersedeCause} if the run was lost; then the caller must not drive failure
 * closure.
 * Exported for tests only.
 */
export async function markRunFailed(
  run: RunRow,
  stepId: string,
  attempt: number,
  error: string,
): Promise<SupersedeCause | null> {
  // Bound once (ADR-0070 §8): an over-cap message would make the frame throw and loop the run.
  const safeError = boundAgentRunError(error);

  try {
    await db().transaction(async (tx) => {
      const now = new Date();

      const outcome = await deriveRunOutcome(tx, run, {
        status: "failed",
        code: "workflow_unresolved",
        safeMessage: safeError,
      });

      await commitGuardedRunUpdate(tx, run, stepId, attempt, {
        status: "failed",
        error: { message: safeError },
        outcome,
        endedAt: now,
      });
      await recordWorkflowLastRun(tx, run, "failed", now);

      // Every terminal path publishes `agent.run` (ADR-0073). The client's replay barrier
      // for a non-chat run waits for it (`replay-state.ts` `releasedRunId`).
      await publishRunFailed(tx, {
        userId: run.userId,
        runId: run.id,
        step: stepId,
        attempt,
        error: safeError,
      });
    });
  } catch (err) {
    if (err instanceof RunSupersededError) return err.supersedeCause;
    throw err;
  }

  pokeWorkflowOwner(run);

  return null;
}
