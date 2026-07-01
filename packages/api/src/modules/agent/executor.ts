import type { AgentTranscriptMessage } from "@alfred/contracts";
import { sanitizeErrorMessage, sanitizeToolResult } from "@alfred/contracts";
import { db, rowsFromExecute } from "@alfred/db";
import { agentDecisionTraces, agentRuns, agentSteps, pendingActions } from "@alfred/db/schemas";
import { runStatusSchema } from "@alfred/schemas";
import { and, eq, sql } from "drizzle-orm";
import { publishEvent } from "../../events/publish";
import { normalizeDecisionTraceKey, type DecisionTraceRecord } from "./decision-traces";
import { isUniqueViolation, resolveStaleAfterMs, resolveWorkflowForRun } from "./service";
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
/**
 * ADR-0070 §1.4 — a step reclaimed this many times since its last successful
 * run is treated as non-progressing and the run is failed terminally. The
 * first reclaim is free (a genuine worker death recovers), so this trips on
 * the 3rd consecutive reclaim of the same step.
 */
const BACKSTOP_RECLAIM_LIMIT = 3;

/**
 * Thrown inside `commitStepSuccess`'s transaction when the guarded `agent_runs`
 * UPDATE matches 0 rows — meaning the run's `attempt` no longer equals the one
 * this step ran under, i.e. a stale-lease reclaim (executor lease, §`leaseRun`)
 * bumped `attempt` and another worker is (or already finished) re-running this
 * step. Throwing rolls back the whole commit (step row, staged actions, traces),
 * so the superseded worker's wasted LLM result lands nowhere and only the
 * reclaimer's commit advances the run. Caught at the `commitStepSuccess`
 * boundary and reported as a benign `skipped` outcome (no re-enqueue).
 *
 * This closes the double-advance / transcript-divergence hazard a too-tight
 * stale threshold (STALE_RUN_LEASE_MS) opens against long model turns. It does
 * NOT un-bill the duplicate model call — both workers already called the model
 * before either reached commit; reducing false reclaims (the threshold) is the
 * lever for that.
 */
class RunSupersededError extends Error {
  constructor(runId: string, stepId: string, attempt: number) {
    super(`run ${runId} step ${stepId} attempt ${attempt} superseded by reclaim before commit`);
    this.name = "RunSupersededError";
  }
}

export type RunOutcome =
  | { kind: "advanced"; runId: string; nextStep: string }
  | { kind: "completed"; runId: string }
  | { kind: "interrupted"; runId: string; wake: WakeCondition }
  | { kind: "failed"; runId: string; error: string }
  | { kind: "skipped"; runId: string; reason: string };

/**
 * Result of attempting to lease a run for a step:
 *  - `leased` — we hold it; run the step at `attempt`.
 *  - `backstopped` — the non-progressing-step backstop (ADR-0070 §1.4) tripped
 *    and terminal-failed `run` inside the lease tx; no step runs, but the
 *    caller must still drive workflow-level failure finalization.
 *  - `none` — no lease: held by a live worker, already terminal, or waiting.
 */
export type LeaseResult =
  | { kind: "leased"; run: RunRow; attempt: number }
  | { kind: "backstopped"; run: RunRow; error: string }
  | { kind: "none" };

interface RunRow {
  id: string;
  userId: string;
  workflowSlug: string;
  status: RunStatus;
  state: unknown;
  transcript: AgentTranscriptMessage[];
  currentStep: string;
  attempt: number;
  metadata: unknown;
}

export interface RunOnceOptions {
  /**
   * Called after a run is leased and its per-attempt step row is inserted, right
   * before the step body starts. The worker uses this to heartbeat the specific
   * leased attempt; a superseded worker must not refresh a newer attempt.
   */
  onLeased?: (lease: { runId: string; stepId: string; attempt: number }) => void;
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
export async function runOnce(runId: string, opts: RunOnceOptions = {}): Promise<RunOutcome> {
  // 1) Lease the run. If another worker holds it, or it's terminal, skip.
  const leased = await leaseRun(runId);
  if (leased.kind === "none") {
    return { kind: "skipped", runId, reason: "no_lease" };
  }
  // The backstop already terminal-failed the run inside the lease tx (and
  // published `agent.run failed`). It runs *outside* any step body, so a
  // workflow that owns client-facing closure (chat-turn) hasn't finalized —
  // drive its `onTerminalFailure` here, then report the terminal failure.
  if (leased.kind === "backstopped") {
    await finalizeWorkflowFailure(leased.run, leased.error);
    return { kind: "failed", runId, error: leased.error };
  }

  const { run, attempt } = leased;
  const stepId = run.currentStep;
  const idempotencyKey = `${run.id}:${stepId}:${attempt}`;

  // 2) Resolve workflow + step. If the deploy dropped them, fail hard —
  //    silent skip would leave a zombie run.
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
    const error = errorMessage(err);
    await markRunFailed(run.id, error);
    // A post-deploy step-resolution failure also never enters a step body, so
    // drive workflow-level closure (e.g. chat-turn's failed-message finalize)
    // the same way the backstop does.
    await finalizeWorkflowFailure(run, sanitizeErrorMessage(error));
    return { kind: "failed", runId: run.id, error };
  }

  // 3) Insert the per-attempt step row. Conflict means a previous run of
  //    this exact attempt already committed — re-enqueue so the worker
  //    picks up whatever the row says happened.
  const inserted = await tryInsertStepRow(run.id, stepId, attempt, run.state);
  if (!inserted) {
    return { kind: "skipped", runId: run.id, reason: "step_already_committed" };
  }
  opts.onLeased?.({ runId: run.id, stepId, attempt });

  await publishEvent({
    userId: run.userId,
    kind: "agent.run",
    payload: { runId: run.id, phase: "step_started", step: stepId, attempt },
  });

  // 4) Run the step body outside the commit transaction. Side effects are
  //    deferred via `stageAction` and committed atomically below.
  const staged: StagedAction[] = [];
  const traces: DecisionTraceRecord[] = [];
  const seenTraceKeys = new Set<string>();
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
    trace(kind, record, options) {
      const decisionKey = normalizeDecisionTraceKey(options?.decisionKey);
      const slot = `${kind}\u0000${decisionKey}`;
      if (seenTraceKeys.has(slot)) {
        throw new Error(
          `[agent] duplicate decision trace kind=${kind} decisionKey=${decisionKey} in step=${stepId}`,
        );
      }
      seenTraceKeys.add(slot);
      traces.push({ kind, decisionKey, record } as DecisionTraceRecord);
    },
  };

  let result: StepResult<unknown>;
  try {
    result = await step.run(ctx);
  } catch (err) {
    const error = errorMessage(err);
    return await commitStepFailure(run, stepId, attempt, error);
  }

  // 5) Commit success in one tx: step row, run row, staged actions, decision
  //    traces, lifecycle event.
  return await commitStepSuccess(run, stepId, attempt, result, staged, traces);
}

/**
 * Exported for the lease-test harness (#137 / ADR-0070 §1.4). Not part of the
 * public executor surface — `runOnce` is the only production caller.
 */
export async function leaseRun(runId: string): Promise<LeaseResult> {
  return await db().transaction(async (tx) => {
    const result = await tx.execute(sql`
      SELECT id, user_id AS "userId", workflow_slug AS "workflowSlug", status,
             state, transcript, current_step AS "currentStep", attempt, metadata,
             EXTRACT(EPOCH FROM (now() - last_checkpoint_at)) * 1000 AS "staleMs"
      FROM agent_runs
      WHERE id = ${runId}
      FOR UPDATE SKIP LOCKED
    `);

    const row = rowsFromExecute<RunRow & { staleMs: number | string | null }>(result)[0];
    if (!row) return { kind: "none" };

    const status = runStatusSchema.parse(row.status);
    if (isTerminalStatus(status)) return { kind: "none" };
    if (status === "waiting") return { kind: "none" }; // signal will flip to runnable first

    // A `running` row is normally held by another worker. But if its
    // heartbeat (`last_checkpoint_at`) is older than the lease window,
    // the previous worker is presumed dead and we reclaim — bumping the
    // attempt so the in-flight `agent_steps` row's unique key (run, step,
    // attempt) doesn't collide on the next insert. The orphan step row
    // is marked failed for audit visibility.
    let isStaleRunning = false;
    if (status === "running") {
      const staleMs = typeof row.staleMs === "string" ? Number(row.staleMs) : row.staleMs;
      // Per-step stale window (ADR-0070 §1.4, Lever A): a long model-call step
      // (a boss turn) declares a wider window so a heartbeat blip can't reclaim
      // a live, expensive turn. Unset steps use the default STALE_RUN_LEASE_MS.
      const staleAfterMs = resolveStaleAfterMs(row.workflowSlug, row.currentStep);
      if (staleMs == null || staleMs >= staleAfterMs) {
        isStaleRunning = true;
      } else {
        return { kind: "none" }; // another worker has it, heartbeat is fresh
      }
    }

    // ADR-0070 §1.4 — non-progressing-step backstop. A step that can never
    // commit (e.g. a result the DB refuses to persist that somehow bypassed
    // the sanitizer) would be reclaimed forever. Before re-leasing a
    // stale-`running` row, count how many times THIS step has already been
    // reclaimed since its last *successful* run; if this reclaim would be the
    // Nth, fail the run terminally instead of looping. One genuine worker
    // death still recovers (the first reclaim is free). We match on the
    // structured `error->>'reason'='lease_reclaimed'` marker, never the prose
    // message, so rewording the message can't silently disable the safety net.
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
               -- Both are genuine forward progress: 'completed' (the step ran
               -- and advanced/finished) and 'interrupted' (the step ran and
               -- parked for HIL/wake, then resumes at attempt+1). A reclaim
               -- after either must NOT count toward the backstop limit.
               AND status IN ('completed', 'interrupted')),
            -1
          )
      `);
      const priorReclaims = rowsFromExecute<{ reclaims: number }>(countResult)[0]?.reclaims ?? 0;
      if (priorReclaims + 1 >= BACKSTOP_RECLAIM_LIMIT) {
        const now = new Date();
        const backstopError = `step ${row.currentStep} not progressing: reclaimed ${priorReclaims + 1} times`;
        // Mark the orphan step failed for audit, with the same structured
        // marker so the history reads consistently.
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
        // Terminal-fail the run. The message MUST be this synthetic clean
        // string and must NOT echo the original error — else the terminal
        // write would re-throw on the same poison and the run would survive
        // its own backstop.
        await tx
          .update(agentRuns)
          .set({
            status: "failed",
            error: {
              message: backstopError,
              step: row.currentStep,
              attempt: row.attempt,
            },
            endedAt: now,
            lastCheckpointAt: now,
            updatedAt: now,
          })
          .where(eq(agentRuns.id, row.id));
        await publishEvent({
          tx,
          userId: row.userId,
          kind: "agent.run",
          payload: {
            runId: row.id,
            phase: "failed",
            step: row.currentStep,
            attempt: row.attempt,
            error: backstopError,
          },
        });
        // Do not re-lease — the run is now terminal. Hand the caller the run
        // row + clean message so it can drive workflow-level failure closure.
        return {
          kind: "backstopped",
          run: { ...row, status, attempt: row.attempt },
          error: backstopError,
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
      .update(agentRuns)
      .set({
        status: "running",
        attempt,
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

    return { kind: "leased", run: { ...row, status, attempt }, attempt };
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

/**
 * Exported for the attempt-guard test harness (see
 * `test/agent/commit-attempt-guard.test.ts`). `runOnce` is the only production
 * caller.
 */
export async function commitStepSuccess(
  run: RunRow,
  stepId: string,
  attempt: number,
  result: StepResult<unknown>,
  staged: StagedAction[],
  traces: DecisionTraceRecord[],
): Promise<RunOutcome> {
  // ADR-0070 §1.1/1.3: every jsonb sink this commit writes — `agent_runs.state`,
  // `agent_runs.transcript`, the step/run `output`, each staged action payload,
  // and the interrupt `wake` — can carry model-derived poison (U+0000 / a lone
  // surrogate) that the dispatch-boundary sanitizer never saw: e.g. assistant
  // text or a tool-call *input* the model emitted, replayed in the transcript.
  // The chat row is sanitized in its own transaction *before* this commit
  // (chat-turn `finalizeAssistantMessage`), so an unsanitized sink here would
  // throw on the jsonb write *after* the user-visible message is already
  // `complete`, leaving the run stuck `running` → reclaim/backstop — the exact
  // message/run split ADR-0072 kills. Strip every sink once, here, for ALL
  // workflows. Clean values pass through by reference (no extra allocation).
  const cleanState = sanitizeToolResult(result.state).value;
  const cleanTranscript =
    result.transcript === undefined
      ? undefined
      : (sanitizeToolResult(result.transcript).value as AgentTranscriptMessage[]);
  const cleanOutput =
    result.kind === "done"
      ? (sanitizeToolResult(result.output ?? null).value as object | null)
      : null;
  const cleanWake =
    result.kind === "interrupt"
      ? (sanitizeToolResult(result.wake).value as WakeCondition)
      : undefined;

  try {
    return await commitStepSuccessTx(
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
  } catch (err) {
    // The run was reclaimed (attempt bumped) while this step ran; the guarded
    // commit matched 0 rows and rolled back. Report benign skip — do NOT
    // re-enqueue (the reclaimer owns the run now). Never resurrects the run.
    if (err instanceof RunSupersededError) {
      return { kind: "skipped", runId: run.id, reason: "superseded_by_reclaim" };
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
  traces: DecisionTraceRecord[],
  cleanState: unknown,
  cleanTranscript: AgentTranscriptMessage[] | undefined,
  cleanOutput: object | null,
  cleanWake: WakeCondition | undefined,
): Promise<RunOutcome> {
  return await db().transaction(async (tx) => {
    const now = new Date();

    await tx
      .update(agentSteps)
      .set({
        status: result.kind === "interrupt" ? "interrupted" : "completed",
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
          payload: sanitizeToolResult(action.payload).value as object,
          idempotencyKey: key,
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }

    // Durable decision traces (#219 PR-A). Same poison-strip as every other
    // jsonb sink above; `(run_id, step_id, attempt, kind, decision_key)` is
    // unique, so a re-run within the same trace slot is a no-op.
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
            trace: sanitizeToolResult(t.record).value as object,
          })),
        )
        .onConflictDoNothing();
    }

    if (result.kind === "next") {
      const committed = await tx
        .update(agentRuns)
        .set({
          state: cleanState as object,
          currentStep: result.nextStep,
          // Monotonic per-run execution counter, NOT reset to 0. The
          // `agent_steps` row identity is `(run_id, step_id, attempt)`, and a
          // workflow that loops back into a step it already ran (e.g. chat-turn
          // -> dispatch-tools -> chat-turn) would re-enter at attempt 0 and
          // collide with the earlier visit's row. That collision made
          // `tryInsertStepRow` return false -> `runOnce` reported
          // `step_already_committed` and the worker did NOT re-enqueue, so the
          // run stalled ~60-90s until the stale-lease sweep reclaimed it with
          // attempt+1. Carrying the counter forward keeps every step execution
          // unique, so each loop iteration runs immediately. (attempt is only
          // used for attribution/idempotency keys, never as a retry cap.)
          attempt: attempt + 1,
          status: "runnable",
          lastCheckpointAt: now,
          updatedAt: now,
          ...(cleanTranscript === undefined ? {} : { transcript: cleanTranscript }),
        })
        // Attempt-guard: only commit if the run is still at the attempt this
        // step ran under. A stale-lease reclaim bumps `attempt`, so a 0-row
        // match means we were superseded — abort (rollback) instead of
        // double-advancing the run with a duplicate transcript.
        .where(and(eq(agentRuns.id, run.id), eq(agentRuns.attempt, attempt)))
        .returning({ id: agentRuns.id });
      if (committed.length === 0) throw new RunSupersededError(run.id, stepId, attempt);

      await publishEvent({
        tx,
        userId: run.userId,
        kind: "agent.run",
        payload: { runId: run.id, phase: "step_completed", step: stepId, attempt },
      });
      return { kind: "advanced", runId: run.id, nextStep: result.nextStep };
    }

    if (result.kind === "done") {
      const committed = await tx
        .update(agentRuns)
        .set({
          state: cleanState as object,
          status: "completed",
          output: cleanOutput,
          endedAt: now,
          lastCheckpointAt: now,
          updatedAt: now,
          ...(cleanTranscript === undefined ? {} : { transcript: cleanTranscript }),
        })
        // Attempt-guard (see the `next` branch): a 0-row match means a reclaim
        // superseded us — abort so we don't mark a run completed under a stale
        // attempt while the reclaimer is mid-step.
        .where(and(eq(agentRuns.id, run.id), eq(agentRuns.attempt, attempt)))
        .returning({ id: agentRuns.id });
      if (committed.length === 0) throw new RunSupersededError(run.id, stepId, attempt);

      await publishEvent({
        tx,
        userId: run.userId,
        kind: "agent.run",
        payload: { runId: run.id, phase: "completed", step: stepId, attempt },
      });
      return { kind: "completed", runId: run.id };
    }

    // interrupt
    const wake = cleanWake!;
    const committed = await tx
      .update(agentRuns)
      .set({
        state: cleanState as object,
        status: "waiting",
        wakeCondition: wake,
        attempt: attempt + 1, // next attempt of the same step on resume
        lastCheckpointAt: now,
        updatedAt: now,
        ...(cleanTranscript === undefined ? {} : { transcript: cleanTranscript }),
      })
      // Attempt-guard (see the `next` branch): a 0-row match means a reclaim
      // superseded us — abort so we don't park the run (and fire an approval /
      // signal wake) under a stale attempt the reclaimer no longer owns.
      .where(and(eq(agentRuns.id, run.id), eq(agentRuns.attempt, attempt)))
      .returning({ id: agentRuns.id });
    if (committed.length === 0) throw new RunSupersededError(run.id, stepId, attempt);

    if (wake.kind === "hil") {
      await publishEvent({
        tx,
        userId: run.userId,
        kind: "approval.requested",
        payload: {
          runId: run.id,
          approvalId: wake.approvalId,
          // Default to "step" for the legacy approval kind — pre-m13 steps
          // returning HIL wakes didn't carry this field.
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
  // ADR-0070 §1.3: the throw-poison class. A tool/step that throws a NUL-byte
  // message would re-throw on the jsonb error write here, escaping the catch
  // and leaving the run `running` → the reclaim loop. Strip before persisting.
  const safeError = sanitizeErrorMessage(error);
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

      const committed = await tx
        .update(agentRuns)
        .set({
          status: "failed",
          error: { message: safeError, step: stepId, attempt },
          endedAt: now,
          lastCheckpointAt: now,
          updatedAt: now,
        })
        .where(and(eq(agentRuns.id, run.id), eq(agentRuns.attempt, attempt)))
        .returning({ id: agentRuns.id });
      if (committed.length === 0) throw new RunSupersededError(run.id, stepId, attempt);

      await publishEvent({
        tx,
        userId: run.userId,
        kind: "agent.run",
        payload: { runId: run.id, phase: "failed", step: stepId, attempt, error: safeError },
      });
    });
  } catch (err) {
    // Same race as success commits: a reclaim bumped attempt while this worker
    // was running. Roll back the step failure and leave the reclaimer in charge.
    if (err instanceof RunSupersededError) {
      return { kind: "skipped", runId: run.id, reason: "superseded_by_reclaim" };
    }
    throw err;
  }
  return { kind: "failed", runId: run.id, error: safeError };
}

/**
 * Drive a workflow's `onTerminalFailure` hook (ADR-0070 §1.4) after the run was
 * already terminal-failed in the DB by a path that never entered a step body
 * (the non-progressing backstop, a post-deploy step-resolution failure). For
 * chat-turn this writes the failed assistant row + emits `chat.message
 * completed` so the streaming bubble reconciles instead of hanging forever.
 *
 * Best-effort by contract: the run is already failed, so any throw here (an
 * unresolvable workflow after a deploy, a state-schema drift, the hook itself)
 * is logged and swallowed — it must not resurrect or re-fail the run.
 */
async function finalizeWorkflowFailure(run: RunRow, error: string): Promise<void> {
  try {
    const { workflow } = await resolveWorkflowForRun({
      userId: run.userId,
      workflowSlug: run.workflowSlug,
    });
    if (!workflow.onTerminalFailure) return;
    const state = workflow.stateSchema ? workflow.stateSchema.parse(run.state) : run.state;
    await workflow.onTerminalFailure({
      runId: run.id,
      userId: run.userId,
      state,
      error,
    });
  } catch (err) {
    console.warn(
      `[agent] onTerminalFailure for run ${run.id} (${run.workflowSlug}) failed:`,
      errorMessage(err),
    );
  }
}

async function markRunFailed(runId: string, error: string): Promise<void> {
  await db()
    .update(agentRuns)
    .set({
      status: "failed",
      // ADR-0070 §1.3: throw-poison class — strip before the jsonb write.
      error: { message: sanitizeErrorMessage(error) },
      endedAt: new Date(),
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
