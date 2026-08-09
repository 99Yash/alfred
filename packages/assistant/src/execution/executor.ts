import type { AgentRunError, AgentTranscriptMessage } from "@alfred/contracts";
import {
  AGENT_STEP_PROGRESS_STATUSES,
  boundAgentRunError,
  sanitizeErrorMessage,
  sanitizeToolResult,
  toMessage,
} from "@alfred/contracts";
import { db, rowsFromExecute, type DbTransaction } from "@alfred/db";
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
import { normalizeDecisionTraceKey, type DecisionTraceRecord } from "./decision-traces";
import { resolveWorkflowForRun } from "./resolve-workflow";
import { rejectLateCancelledRunStagings, resolveStaleAfterMs } from "./service";
import { finalizeFailedRun } from "./terminal-closure";
import { isUniqueViolation } from "@alfred/db/pg-errors";
import { startQueueLeaseSpan, type QueueLeaseFromStatus } from "./runtime-spans";
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
 * Why this worker no longer owns the run it is about to write to.
 *  - `reclaim`  — the run's `attempt` moved on (a stale-lease reclaim owns it).
 *  - `terminal` — the run reached a terminal status mid-step (#530: a cancel
 *    landed while this worker was inside the step body).
 */
export type SupersedeCause = "reclaim" | "terminal";

/** Benign `skipped` reason reported for each {@link SupersedeCause}. */
const SUPERSEDE_SKIP_REASON = {
  reclaim: "superseded_by_reclaim",
  terminal: "run_already_terminal",
} as const satisfies Record<SupersedeCause, string>;

/**
 * Every reason `runOnce` reports a benign `skipped` — nothing ran, nothing to
 * re-enqueue. A closed union rather than `string` so the reporting decision can
 * be made per member and checked; see {@link SKIP_REASON_VOLUME}.
 */
export type RunSkipReason =
  | "no_lease"
  | "step_already_committed"
  | (typeof SUPERSEDE_SKIP_REASON)[SupersedeCause];

/**
 * How loudly the worker reports each skip. Declared as data and checked
 * exhaustively for the same reason {@link SUPERSEDE_SKIP_REASON} is: the
 * hand-written `reason === "superseded_by_reclaim" || reason === "run_already_terminal"`
 * this replaces answered "quiet" for a third {@link SupersedeCause} — silently,
 * and a new supersede cause is exactly the kind that would want reporting.
 * Adding one now widens `RunSkipReason` and fails this `satisfies`.
 *
 *  - `loud` — never free. Both supersede causes mean two workers reached commit
 *    on one step, so the model was called twice at full price; a
 *    `superseded_by_reclaim` additionally says the step's stale window is too
 *    tight. Without a log the only trace is the bill.
 *  - `quiet` — routine and high-volume. `no_lease` fires whenever a sweep and a
 *    worker race for a run, `step_already_committed` on every re-delivered job.
 */
const SKIP_REASON_VOLUME = {
  no_lease: "quiet",
  step_already_committed: "quiet",
  superseded_by_reclaim: "loud",
  run_already_terminal: "loud",
} as const satisfies Record<RunSkipReason, "loud" | "quiet">;

/** Should the worker log this skip? See {@link SKIP_REASON_VOLUME}. */
export function skipReasonIsLoud(reason: RunSkipReason): boolean {
  return SKIP_REASON_VOLUME[reason] === "loud";
}

/**
 * Thrown inside a commit transaction when {@link guardRunOwnership} finds this
 * worker no longer owns the run. Two things cause that:
 *
 *  - `reclaim` — the run's `attempt` no longer equals the one this step ran
 *    under, i.e. a stale-lease reclaim (executor lease, §`leaseRun`) bumped
 *    `attempt` and another worker is (or already finished) re-running this step.
 *  - `terminal` — the run reached a terminal status while the step body was
 *    executing (#530), which in practice means `cancelRun` flipped it to
 *    `cancelled`. Its only production trigger is the approvals panel's
 *    `cancel_run` decision ("Reject and end run"); the composer's stop button is
 *    a *different* path (a Redis flag, see `chat/stop-signal.ts`) and never
 *    reaches here. The worker holds no row lock during the step body, so the
 *    cancel's `FOR UPDATE` gives no protection; only this guard does.
 *
 * Throwing rolls back the executor-owned commit (step row, pending actions,
 * traces and outbox rows), so
 * the superseded worker's wasted LLM result lands nowhere — and, for the
 * terminal case, the cancelled run is not resurrected into
 * `runnable`/`completed`/`waiting` and no `approval.requested` is re-fired on a
 * run whose action stagings were just rejected. Caught at each commit boundary
 * and reported as a benign `skipped` outcome (no re-enqueue).
 *
 * This closes the double-advance / transcript-divergence hazard a too-tight
 * stale threshold (STALE_RUN_LEASE_MS) opens against long model turns. It does
 * NOT un-bill the duplicate model call — both workers already called the model
 * before either reached commit; reducing false reclaims (the threshold) is the
 * lever for that. Same for a mid-step cancel: the guard prevents the zombie
 * run, not the model call already in flight when the cancel landed.
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
 * Does this worker still own the run? Returns `null` when it does, otherwise the
 * {@link SupersedeCause} that took it away.
 *
 * `SELECT ... FOR UPDATE`, deliberately, and deliberately in ONE statement:
 *
 *  - The lock is the guard. Once it is held, a concurrent cancel's own
 *    `FOR UPDATE` blocks until this commit's transaction ends, so the status
 *    this read observes is the status the subsequent write lands against. The
 *    earlier shape — a guarded UPDATE, then a separate classifying SELECT on the
 *    miss path — took a *newer* READ COMMITTED snapshot than the write it was
 *    explaining, so a pure reclaim miss re-labelled itself `terminal` whenever
 *    the reclaimer committed in the gap (#530/#531 review, D3).
 *  - `reclaim` wins ties. A worker can be superseded by BOTH at once (reclaimed,
 *    then the reclaimer completed the run), and only one label survives.
 *    `reclaim` is strictly the more actionable of the two: it means a duplicate
 *    full-price model call happened and the stale threshold wants tuning, where
 *    `run_already_terminal` reads as "the user cancelled" and closes the
 *    investigation.
 *
 * Lock order — stated rather than claimed clean, because it is not. The commit
 * transactions call this after their `agent_steps` / `pending_actions` / trace
 * writes, so they hold an `agent_steps` row lock before they ask for this
 * `agent_runs` one. `leaseRun` takes the two in the opposite order: `agent_runs`
 * `FOR UPDATE SKIP LOCKED` at the top of its tx, then — on the reclaim path — the
 * orphan `agent_steps` UPDATE for the same `(run, step, attempt)` this commit is
 * writing. That is an ABBA pair, and a reclaim racing a commit of the same step
 * can resolve as a Postgres deadlock (40P01) rather than as a supersede.
 *
 * Pre-existing, not opened by this guard: the shape it replaced (a status-guarded
 * UPDATE) took the same `agent_runs` row lock at the same point of the same
 * transaction. What happens when it fires: 40P01 is not a
 * {@link RunSupersededError}, so it is rethrown, `processAgentJob` fails, and
 * BullMQ retries — by which time the run is reclaimed or terminal and the retry
 * skips. Noisy (an error log for a benign race) but not a correctness hole: the
 * aborted transaction rolled the whole commit back, which is what this guard
 * would have done anyway. Closing it is not as simple as taking this guard
 * first: that would let a commit already holding `agent_runs` beat a cancel
 * that arrived mid-commit, publish `approval.requested`, and only then allow the
 * cancel through. The present late guard intentionally lets a cancellation
 * that lands during the step-owned writes win before any outbox event is
 * published. Removing the ABBA pair therefore needs a transaction design that
 * preserves that cancellation precedence, not just a lock-order shuffle.
 *
 * `cancelRunInTx` is not part of that pair: it takes its own `agent_runs` row and
 * then possibly the parent's, and touches no `agent_steps`.
 *
 * This is also not the last statement in its transaction — `publishEvent` writes
 * the outbox after it in every commit branch. It is the last `agent_runs` write,
 * which is what the pair above turns on.
 */
async function guardRunOwnership(
  tx: DbTransaction,
  runId: string,
  attempt: number,
): Promise<SupersedeCause | null> {
  const rows = await tx
    .select({ status: agentRuns.status, attempt: agentRuns.attempt })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .for("update");
  const row = rows[0];
  // A vanished row is a reclaim-shaped miss (nothing to resurrect).
  if (!row) return "reclaim";
  if (row.attempt !== attempt) return "reclaim";
  const status = runStatusSchema.safeParse(row.status);
  // Persisted protocol drift must fail closed. Treat an unknown status as
  // terminal so this worker rolls back and skips instead of retrying forever
  // against the same unparsable row.
  return !status.success || isTerminalStatus(status.data) ? "terminal" : null;
}

/**
 * THE door for every `agent_runs` status write the executor makes: take the row
 * lock, refuse if this worker was superseded, then apply `set`.
 *
 * A stale-lease reclaim bumps `attempt`; a cancel flips `status` without
 * touching `attempt` (#530). Either way, being superseded means throwing
 * {@link RunSupersededError} so the caller rolls back rather than
 * double-advancing / double-parking / double-completing the run, or writing a
 * live status over a terminal one.
 *
 * Callers, all five in this file: the `next` / `done` / `interrupt` branches of
 * `commitStepSuccessTx`, `commitStepFailure`, and `markRunFailed`. The last one
 * was the miss the docstring here used to paper over — it wrote `failed` with a
 * bare `where(eq(id))`, so a cancel landing during workflow resolution was
 * overwritten and a failure bubble was rendered on a turn the user had ended
 * (#530/#531 review, D1). The fifth writer, `leaseRun`'s backstop, is safe by a
 * different mechanism: it already holds `FOR UPDATE` on the row from the top of
 * its own transaction and has checked the status under that lock.
 */
async function commitGuardedRunUpdate(
  tx: DbTransaction,
  run: RunRow,
  stepId: string,
  attempt: number,
  set: PgUpdateSetSource<typeof agentRuns>,
): Promise<void> {
  const cause = await guardRunOwnership(tx, run.id, attempt);
  if (cause) throw new RunSupersededError(run.id, stepId, attempt, cause);
  await tx.update(agentRuns).set(set).where(eq(agentRuns.id, run.id));
}

/**
 * THE single builder for the executor's `agent.run`/`failed` frame. Every
 * terminal-fail site — `commitStepFailure`, `markRunFailed`, and the lease
 * backstop — mints the identical `{ runId, phase: "failed", step, attempt,
 * error }` payload through here, so a fourth writer cannot drift the shape
 * (ADR-0073:19, mirroring `tool-card-events.ts` as the sole `chat.tool`
 * builder; ADR-0073:23, every terminal path publishes one `agent.run` frame).
 *
 * `tx` is required, not optional: the frame MUST commit with the caller's
 * status write so a cancel that supersedes the write rolls the frame back too —
 * no `failed` frame leaks over `cancelled` (#530).
 *
 * `error` is an `AgentRunError` — a branded string the caller minted through
 * `boundAgentRunError`, so it is ALREADY stripped and bounded by construction
 * (the type states what item 61's prose used to). This helper does NOT
 * sanitize: sanitize-once keeps the safe string coupled to each site's DB write
 * (`commitStepFailure` / `markRunFailed` reuse their `safeError`), and the lease
 * backstop's `backstopError` is a synthetic clean string that ADR-0070 forbids
 * re-stripping. Folding the sanitize or the DB write here would corrupt the
 * backstop path — the helper owns the frame publish only.
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

export type RunOutcome =
  | { kind: "advanced"; runId: string; nextStep: string }
  | { kind: "completed"; runId: string }
  | { kind: "interrupted"; runId: string; wake: WakeCondition }
  | { kind: "deferred"; runId: string; retryAt: Date }
  | { kind: "blocked"; runId: string }
  | { kind: "failed"; runId: string; error: string }
  | { kind: "skipped"; runId: string; reason: RunSkipReason };

/**
 * Result of attempting to lease a run for a step:
 *  - `leased` — we hold it; run the step at `attempt`.
 *  - `backstopped` — the non-progressing-step backstop (ADR-0070 §1.4) tripped
 *    and terminal-failed `run` inside the lease tx; no step runs, but the
 *    caller must still drive workflow-level failure finalization.
 *  - `none` — no lease: held by a live worker, already terminal, or waiting.
 */
export type LeaseResult =
  | { kind: "leased"; run: RunRow; attempt: number; queue: LeaseQueueInfo }
  | { kind: "backstopped"; run: RunRow; error: string; queue: LeaseQueueInfo }
  | { kind: "none" };

/**
 * Queue-timing snapshot captured while leasing, threaded out so `runOnce` can
 * emit the `runtime.queue.lease` span *outside* the `FOR UPDATE` tx (#409) —
 * keeping tracing off the hot lock path.
 */
interface LeaseQueueInfo {
  /** now - last_checkpoint_at at lease time (ms); null when the row was never checkpointed. */
  staleMs: number | null;
  /** Run status observed just before this lease flipped it to `running`. */
  fromStatus: QueueLeaseFromStatus;
  /** True when a stale `running` row was reclaimed (previous worker presumed dead). */
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
    | "metadata"
    | "deferredUntil"
  >,
  "status"
> & {
  status: RunStatus;
};

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
  // drive its `onTerminal` failure branch here, then report the terminal failure.
  if (leased.kind === "backstopped") {
    await finalizeFailedRun(leased.run, leased.error);
    return { kind: "failed", runId, error: leased.error };
  }

  const { run, attempt } = leased;
  const stepId = run.currentStep;
  const idempotencyKey = `${run.id}:${stepId}:${attempt}`;

  // #409: record the queue/reclaim wall-clock this lease just closed — the time
  // the run sat between steps (or, on reclaim, since the dead worker's last
  // heartbeat). Emitted here, outside `leaseRun`'s FOR UPDATE tx, so tracing
  // never touches the hot lock path; the helper swallows any SDK fault.
  startQueueLeaseSpan({
    runId: run.id,
    workflow: run.workflowSlug,
    stepId,
    fromStatus: leased.queue.fromStatus,
    reclaimed: leased.queue.reclaimed,
    queueMs: leased.queue.staleMs,
    leasedAt: new Date(),
  }).end();

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
    const error = toMessage(err);
    // Guarded like every other terminal write. A cancel can land in the window
    // between the lease committing and the resolve throwing — it is narrower
    // than the step body but the same invariant, and overwriting `cancelled`
    // with `failed` discarded the cancel's reason/`endedAt` and then rendered a
    // failure bubble on a turn the user had already ended (D1). On a miss the
    // cancel path owns closure, so we must not drive failure closure here.
    const superseded = await markRunFailed(run, stepId, attempt, error);
    if (superseded) {
      return { kind: "skipped", runId: run.id, reason: SUPERSEDE_SKIP_REASON[superseded] };
    }
    // A post-deploy step-resolution failure also never enters a step body, so
    // drive workflow-level closure (e.g. chat-turn's failed-message finalize)
    // the same way the backstop does.
    await finalizeFailedRun(run, sanitizeErrorMessage(error));
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
    untransacted: true,
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
        untransacted: true,
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
    const error = toMessage(err);
    const outcome = await commitStepFailure(run, stepId, attempt, error);
    if (outcome.kind === "failed") {
      await finalizeFailedRun(run, outcome.error);
    }
    return outcome;
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
    if (status === "waiting") return { kind: "none" }; // signal will flip to runnable first
    if (status === "deferred" && row.deferredUntil && row.deferredUntil > new Date()) {
      return { kind: "none" };
    }

    // A `running` row is normally held by another worker. But if its
    // heartbeat (`last_checkpoint_at`) is older than the lease window,
    // the previous worker is presumed dead and we reclaim — bumping the
    // attempt so the in-flight `agent_steps` row's unique key (run, step,
    // attempt) doesn't collide on the next insert. The orphan step row
    // is marked failed for audit visibility.
    // now - last_checkpoint_at at lease time. Doubles as the queue/reclaim delay
    // the `runtime.queue.lease` span reports (#409); computed for every status,
    // not just `running`. Null when the row was never checkpointed (fresh pending).
    const staleMs =
      row.staleMs == null
        ? null
        : typeof row.staleMs === "string"
          ? Number(row.staleMs)
          : row.staleMs;

    let isStaleRunning = false;
    if (status === "running") {
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
        //
        // The one terminal write that does NOT go through
        // `commitGuardedRunUpdate`, and safely so: this transaction has held
        // `FOR UPDATE` on the row since the SELECT at the top and has already
        // checked the status under that lock, so no concurrent cancel can be
        // interleaved. Adding the guard here would re-read a row we already own.
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
            endedAt: now,
            lastCheckpointAt: now,
            updatedAt: now,
          })
          .where(eq(agentRuns.id, row.id));
        await publishRunFailed(tx, {
          userId: row.userId,
          runId: row.id,
          step: row.currentStep,
          attempt: row.attempt,
          error: backstopError,
        });
        // Do not re-lease — the run is now terminal. Hand the caller the run
        // row + clean message so it can drive workflow-level failure closure.
        return {
          kind: "backstopped",
          run: { ...row, status, attempt: row.attempt },
          error: backstopError,
          // A backstop only trips on a stale `running` row, so this is always a
          // reclaim from `running`.
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
      // drift-ok: this IS the lease. FOR UPDATE SKIP LOCKED held since the
      // SELECT above, which rejected every terminal status under that lock.
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

    // `status` is narrowed to pending | runnable | running | deferred here.
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
    result.kind === "done" || result.kind === "blocked" || result.kind === "defer"
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
    // This worker lost the run while the step ran — reclaimed (attempt bumped)
    // or gone terminal (a cancel landed, #530). Either way the guard refused and
    // the whole commit rolled back. Report a benign skip — do NOT re-enqueue
    // (the reclaimer owns it, or nobody does). Never resurrects the run.
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
          traces.map((t) => {
            // The executor persists traces kind-agnostically. Inside
            // @alfred/assistant the `DecisionTraceRegistry` is empty (each
            // producer augments it from its own package — triage et al.), so
            // `DecisionTraceRecord` collapses to `never` here; read the base
            // shape every trace carries at runtime rather than the registry type.
            const trace = t as { kind: string; decisionKey: string; record: unknown };
            return {
              runId: run.id,
              userId: run.userId,
              workflowSlug: run.workflowSlug,
              stepId,
              attempt,
              kind: trace.kind,
              decisionKey: trace.decisionKey,
              trace: sanitizeToolResult(trace.record).value as object,
            };
          }),
        )
        .onConflictDoNothing();
    }

    if (result.kind === "next") {
      await commitGuardedRunUpdate(tx, run, stepId, attempt, {
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
      // Guarded like the `next` branch: abort rather than mark a run completed
      // under a stale attempt while the reclaimer is mid-step, or over a
      // terminal status a cancel just wrote.
      await commitGuardedRunUpdate(tx, run, stepId, attempt, {
        state: cleanState as object,
        status: "completed",
        output: cleanOutput,
        endedAt: now,
        lastCheckpointAt: now,
        updatedAt: now,
        ...(cleanTranscript === undefined ? {} : { transcript: cleanTranscript }),
      });

      await publishEvent({
        tx,
        userId: run.userId,
        kind: "agent.run",
        payload: { runId: run.id, phase: "completed", step: stepId, attempt },
      });
      return { kind: "completed", runId: run.id };
    }

    if (result.kind === "blocked") {
      await commitGuardedRunUpdate(tx, run, stepId, attempt, {
        state: cleanState as object,
        status: "blocked",
        output: cleanOutput,
        endedAt: now,
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
      await commitGuardedRunUpdate(tx, run, stepId, attempt, {
        state: cleanState as object,
        status: "deferred",
        output: cleanOutput,
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

    // interrupt
    const wake = cleanWake!;
    // Guarded like the `next` branch: abort rather than park the run (and fire an
    // approval / signal wake) under a stale attempt the reclaimer no longer
    // owns, or on a run a cancel just took terminal and whose stagings it
    // already rejected.
    await commitGuardedRunUpdate(tx, run, stepId, attempt, {
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
  // ADR-0070 §1.3 + §8: the throw-poison class AND the length class. A tool/step
  // that throws a NUL-byte message would re-throw on the jsonb error write here,
  // and an over-cap message would make the `agent.run` frame's `safeParse` throw —
  // either escapes the catch, rolls the `failed` write back, and leaves the run
  // `running` → the reclaim loop. `boundAgentRunError` strips AND bounds once, and
  // its branded result is the frame's `error` type, so the persisted
  // `error.message` and the frame `error` carry the identical string.
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

      await commitGuardedRunUpdate(tx, run, stepId, attempt, {
        status: "failed",
        error: { message: safeError, step: stepId, attempt },
        endedAt: now,
        lastCheckpointAt: now,
        updatedAt: now,
      });

      await publishRunFailed(tx, {
        userId: run.userId,
        runId: run.id,
        step: stepId,
        attempt,
        error: safeError,
      });
    });
  } catch (err) {
    // Same races as success commits: a reclaim bumped attempt, or a cancel made
    // the run terminal, while this worker was running. Roll back the step
    // failure — writing `failed` over `cancelled` is exactly #530, and it would
    // also drive a failure bubble on a turn the user deliberately ended.
    if (err instanceof RunSupersededError) {
      if (err.supersedeCause === "terminal") {
        await rejectLateCancelledRunStagings(run.id, "run cancelled before step commit");
      }
      return { kind: "skipped", runId: run.id, reason: SUPERSEDE_SKIP_REASON[err.supersedeCause] };
    }
    throw err;
  }
  return { kind: "failed", runId: run.id, error: safeError };
}

/**
 * Terminal-fail a run from *outside* a step body — currently only a post-deploy
 * step-resolution failure, which has no `agent_steps` row to update alongside it.
 *
 * Goes through {@link commitGuardedRunUpdate} like every other terminal write.
 * Returns the {@link SupersedeCause} when the run was taken away (the caller must
 * then report a skip and NOT drive failure closure — whoever won the race owns
 * it), or `null` when the failure landed.
 *
 * Exported for the terminal-write guard test harness (see
 * `test/agent/commit-cancel-race.test.ts`). `runOnce` is the only production
 * caller, and its window — between the lease committing and workflow resolution
 * throwing — is too narrow to drive deterministically from outside.
 */
export async function markRunFailed(
  run: RunRow,
  stepId: string,
  attempt: number,
  error: string,
): Promise<SupersedeCause | null> {
  // ADR-0070 §8: `boundAgentRunError` strips the throw-poison class AND bounds
  // ONCE, so the persisted `error.message` and the release frame's `error` carry
  // the identical string. Without the bound an over-cap message makes the frame
  // `safeParse` throw, rolls this guarded `failed` write back, and re-enters the
  // reclaim loop.
  const safeError = boundAgentRunError(error);
  try {
    await db().transaction(async (tx) => {
      await commitGuardedRunUpdate(tx, run, stepId, attempt, {
        status: "failed",
        error: { message: safeError },
        endedAt: new Date(),
      });

      // ADR-0073:23 — every terminal path publishes `agent.run`. This one is
      // the resolve-failure path (no `agent_steps` row, so no step-body writer
      // publishes it). `publishRunFailed` puts the frame inside the tx AFTER the
      // guard, so a cancel that supersedes the write rolls this frame back too —
      // the cancel path then owns the terminal frame and no `failed` frame leaks
      // over `cancelled`. Releases the client's `approval.requested`-armed replay
      // barrier for a non-chat run (`replay-state.ts` `releasedRunId`).
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
  return null;
}
