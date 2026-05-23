import { db } from "@alfred/db";
import { agentRuns, agentSteps, pendingActions } from "@alfred/db/schemas";
import type { AgentTranscriptMessage } from "@alfred/contracts";
import { and, eq, sql } from "drizzle-orm";
import { publishEvent } from "../../events/publish";
import { requireWorkflow } from "./registry";
import { STALE_RUN_LEASE_MS } from "./service";
import {
  isTerminalStatus,
  type RunStatus,
  type StagedAction,
  type Step,
  type StepContext,
  type StepResult,
  type WakeCondition,
  type Workflow,
} from "./types";

/**
 * What `runOnce` reports back to the caller (the BullMQ worker). The worker
 * uses this to decide whether to re-enqueue (when a step yielded `next`)
 * or step away (terminal / parked).
 */
export type RunOutcome =
  | { kind: "advanced"; runId: string; nextStep: string }
  | { kind: "completed"; runId: string }
  | { kind: "interrupted"; runId: string; wake: WakeCondition }
  | { kind: "failed"; runId: string; error: string }
  | { kind: "skipped"; runId: string; reason: string };

interface RunRow {
  id: string;
  userId: string;
  workflowSlug: string;
  status: string;
  state: unknown;
  transcript: AgentTranscriptMessage[];
  currentStep: string;
  attempt: number;
  metadata: unknown;
}

/**
 * Execute exactly one step of a run, atomically commit its result, and
 * report what happened. Idempotent across crashes: re-running the same
 * `(runId, stepId, attempt)` either no-ops (a prior commit already
 * landed) or starts a fresh attempt.
 *
 * Concurrency is enforced by the `SELECT ... FOR UPDATE SKIP LOCKED` lease
 * — two workers racing the same run will only see one commit go through.
 */
export async function runOnce(runId: string): Promise<RunOutcome> {
  // 1) Lease the run. If another worker holds it, or it's terminal, skip.
  const leased = await leaseRun(runId);
  if (!leased) {
    return { kind: "skipped", runId, reason: "no_lease" };
  }

  const { run, attempt } = leased;
  const stepId = run.currentStep;
  const idempotencyKey = `${run.id}:${stepId}:${attempt}`;

  // 2) Resolve workflow + step. If the deploy dropped them, fail hard —
  //    silent skip would leave a zombie run.
  let workflow: Workflow<unknown>;
  let step: Step<unknown>;
  try {
    workflow = requireWorkflow(run.workflowSlug);
    step = requireStep(workflow, stepId);
  } catch (err) {
    const error = errorMessage(err);
    await markRunFailed(run.id, error);
    return { kind: "failed", runId: run.id, error };
  }

  // 3) Insert the per-attempt step row. Conflict means a previous run of
  //    this exact attempt already committed — re-enqueue so the worker
  //    picks up whatever the row says happened.
  const inserted = await tryInsertStepRow(run.id, stepId, attempt, run.state);
  if (!inserted) {
    return { kind: "skipped", runId: run.id, reason: "step_already_committed" };
  }

  await publishEvent({
    userId: run.userId,
    kind: "agent.run",
    payload: { runId: run.id, phase: "step_started", step: stepId, attempt },
  });

  // 4) Run the step body outside the commit transaction. Side effects are
  //    deferred via `stageAction` and committed atomically below.
  const staged: StagedAction[] = [];
  const ctx: StepContext<unknown> = {
    runId: run.id,
    userId: run.userId,
    idempotencyKey,
    attempt,
    state: run.state,
    transcript: run.transcript,
    stageAction(action) {
      staged.push(action);
    },
    async log(message) {
      await publishEvent({
        userId: run.userId,
        kind: "agent.progress",
        payload: { runId: run.id, step: stepId, message },
      });
    },
  };

  let result: StepResult<unknown>;
  try {
    result = await step.run(ctx);
  } catch (err) {
    const error = errorMessage(err);
    await commitStepFailure(run, stepId, attempt, error);
    return { kind: "failed", runId: run.id, error };
  }

  // 5) Commit success in one tx: step row, run row, staged actions, lifecycle event.
  return await commitStepSuccess(run, stepId, attempt, result, staged);
}

async function leaseRun(runId: string): Promise<{ run: RunRow; attempt: number } | null> {
  return await db().transaction(async (tx) => {
    const result = await tx.execute(sql`
      SELECT id, user_id AS "userId", workflow_slug AS "workflowSlug", status,
             state, transcript, current_step AS "currentStep", attempt, metadata,
             EXTRACT(EPOCH FROM (now() - last_checkpoint_at)) * 1000 AS "staleMs"
      FROM agent_runs
      WHERE id = ${runId}
      FOR UPDATE SKIP LOCKED
    `);

    const rawRows = (result as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
    const row = (Array.isArray(rawRows) ? rawRows[0] : undefined) as
      | (RunRow & { staleMs: number | string | null })
      | undefined;
    if (!row) return null;

    if (isTerminalStatus(row.status as RunStatus)) return null;
    if (row.status === "waiting") return null; // signal will flip to runnable first

    // A `running` row is normally held by another worker. But if its
    // heartbeat (`last_checkpoint_at`) is older than the lease window,
    // the previous worker is presumed dead and we reclaim — bumping the
    // attempt so the in-flight `agent_steps` row's unique key (run, step,
    // attempt) doesn't collide on the next insert. The orphan step row
    // is marked failed for audit visibility.
    let isStaleRunning = false;
    if (row.status === "running") {
      const staleMs = typeof row.staleMs === "string" ? Number(row.staleMs) : row.staleMs;
      if (staleMs == null || staleMs >= STALE_RUN_LEASE_MS) {
        isStaleRunning = true;
      } else {
        return null; // another worker has it, heartbeat is fresh
      }
    }

    const attempt = isStaleRunning ? row.attempt + 1 : row.attempt;

    if (isStaleRunning) {
      await tx
        .update(agentSteps)
        .set({
          status: "failed",
          error: { message: "lease reclaimed: previous worker presumed dead" },
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
      .update(agentRuns)
      .set({
        status: "running",
        attempt,
        startedAt: row.status === "pending" ? new Date() : undefined,
        lastCheckpointAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId));

    if (row.status === "pending") {
      await publishEvent({
        tx,
        userId: row.userId,
        kind: "agent.run",
        payload: { runId: row.id, phase: "started", workflowSlug: row.workflowSlug },
      });
    }

    return { run: { ...row, attempt }, attempt };
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
 * Insert the step row before running the body. Returns false if a row
 * already exists for this `(runId, stepId, attempt)` — that means a
 * prior crashed run already committed; the executor skips and the
 * caller will re-enter to read the current state.
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
        input: state as object,
      });
    return true;
  } catch (err) {
    // Treat a unique-violation as "already committed" — that's the only
    // way `(runId, stepId, attempt)` collides. Any other error rethrows.
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

async function commitStepSuccess(
  run: RunRow,
  stepId: string,
  attempt: number,
  result: StepResult<unknown>,
  staged: StagedAction[],
): Promise<RunOutcome> {
  return await db().transaction(async (tx) => {
    const now = new Date();

    await tx
      .update(agentSteps)
      .set({
        status: result.kind === "interrupt" ? "interrupted" : "completed",
        output: result.kind === "done" ? ((result.output as object | undefined) ?? null) : null,
        endedAt: now,
      })
      .where(
        and(
          eq(agentSteps.runId, run.id),
          eq(agentSteps.stepId, stepId),
          eq(agentSteps.attempt, attempt),
        ),
      );

    // Stage outbound actions with their per-step idempotency key. Unique
    // index on `idempotency_key` means a re-attempt that re-stages the
    // same action will be silently dropped — exactly what we want.
    for (const action of staged) {
      const key = action.idempotencyKey ?? `${run.id}:${stepId}:${attempt}:${action.kind}`;
      try {
        await tx.insert(pendingActions).values({
          runId: run.id,
          stepId,
          attempt,
          kind: action.kind,
          payload: action.payload as object,
          idempotencyKey: key,
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }

    if (result.kind === "next") {
      await tx
        .update(agentRuns)
        .set({
          state: result.state as object,
          currentStep: result.nextStep,
          attempt: 0, // fresh attempt counter for the next step
          status: "runnable",
          lastCheckpointAt: now,
          updatedAt: now,
          ...(result.transcript === undefined ? {} : { transcript: result.transcript }),
        })
        .where(eq(agentRuns.id, run.id));

      await publishEvent({
        tx,
        userId: run.userId,
        kind: "agent.run",
        payload: { runId: run.id, phase: "step_completed", step: stepId, attempt },
      });
      return { kind: "advanced", runId: run.id, nextStep: result.nextStep };
    }

    if (result.kind === "done") {
      await tx
        .update(agentRuns)
        .set({
          state: result.state as object,
          status: "completed",
          output: (result.output as object | undefined) ?? null,
          endedAt: now,
          lastCheckpointAt: now,
          updatedAt: now,
          ...(result.transcript === undefined ? {} : { transcript: result.transcript }),
        })
        .where(eq(agentRuns.id, run.id));

      await publishEvent({
        tx,
        userId: run.userId,
        kind: "agent.run",
        payload: { runId: run.id, phase: "completed", step: stepId, attempt },
      });
      return { kind: "completed", runId: run.id };
    }

    // interrupt
    await tx
      .update(agentRuns)
      .set({
        state: result.state as object,
        status: "waiting",
        wakeCondition: result.wake,
        attempt: attempt + 1, // next attempt of the same step on resume
        lastCheckpointAt: now,
        updatedAt: now,
        ...(result.transcript === undefined ? {} : { transcript: result.transcript }),
      })
      .where(eq(agentRuns.id, run.id));

    if (result.wake.kind === "hil") {
      await publishEvent({
        tx,
        userId: run.userId,
        kind: "approval.requested",
        payload: {
          runId: run.id,
          approvalId: result.wake.approvalId,
          // Default to "step" for the legacy approval kind — pre-m13 steps
          // returning HIL wakes didn't carry this field.
          approvalKind: result.wake.approvalKind ?? "step",
          prompt: result.wake.prompt ?? "Approval requested",
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
        wake: result.wake,
      },
    });
    return { kind: "interrupted", runId: run.id, wake: result.wake };
  });
}

async function commitStepFailure(
  run: RunRow,
  stepId: string,
  attempt: number,
  error: string,
): Promise<void> {
  await db().transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(agentSteps)
      .set({
        status: "failed",
        error: { message: error },
        endedAt: now,
      })
      .where(
        and(
          eq(agentSteps.runId, run.id),
          eq(agentSteps.stepId, stepId),
          eq(agentSteps.attempt, attempt),
        ),
      );

    await tx
      .update(agentRuns)
      .set({
        status: "failed",
        error: { message: error, step: stepId, attempt },
        endedAt: now,
        lastCheckpointAt: now,
        updatedAt: now,
      })
      .where(eq(agentRuns.id, run.id));

    await publishEvent({
      tx,
      userId: run.userId,
      kind: "agent.run",
      payload: { runId: run.id, phase: "failed", step: stepId, attempt, error },
    });
  });
}

async function markRunFailed(runId: string, error: string): Promise<void> {
  await db()
    .update(agentRuns)
    .set({
      status: "failed",
      error: { message: error },
      endedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(agentRuns.id, runId));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "unknown error";
  }
}

interface PgErrorLike {
  code?: string;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as PgErrorLike).code === "23505";
}
