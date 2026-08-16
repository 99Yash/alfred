import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { AGENT_RUN_ERROR_MAX, getStringPath } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { actionStagings, agentRuns, agentSteps, eventsOutbox, user } from "@alfred/db/schemas";
import { and, eq, inArray, like, sql } from "drizzle-orm";

import { closeRedis } from "@alfred/db/redis";
import { commitStepSuccess, markRunFailed, runOnce } from "@alfred/assistant/execution/executor";
import {
  _resetRegistryForTests,
  getWorkflow,
  registerRecipe,
} from "@alfred/assistant/execution/registry";
import { cancelRun } from "@alfred/assistant/execution/service";
import { spawnSubAgent } from "@alfred/assistant/execution/sub-agents";
import type { StepResult, Workflow } from "@alfred/assistant/execution/types";
import { dbBackedSkip } from "../support/db-backed";

/**
 * DB-backed tests for the mid-flight cancel race (#530).
 *
 * The worker holds no row lock while a step body runs — the lease tx already
 * committed — so a cancel landing mid-step (user "Reject and end run", a
 * sub-agent cancel) writes `status='cancelled'` under a worker that is still
 * executing. `cancelRunInTx` does NOT bump `attempt`, so an attempt-only commit
 * guard still matched: the late commit overwrote `cancelled` with
 * `runnable`/`completed`/`waiting` and the run kept executing and billing, or
 * re-fired `approval.requested` on a run whose stagings were just rejected.
 *
 * The fix is the status half of `commitGuardedRunUpdate`'s guard — a commit
 * only lands while the run is non-terminal. These lock that every commit
 * branch (advance, done, interrupt, failure) refuses to resurrect a cancelled
 * run, and that the refusal is reported as a distinct benign skip.
 *
 * Refusing the commit is only half the invariant, and the review of the first
 * fix caught the other half. Rolling the commit back means NOTHING closes the
 * client-facing turn — the chat bubble streams forever — so the cancel path now
 * drives the workflow's `onTerminal` hook with `outcome: "cancelled"`, and that
 * is asserted here too (finding D2). Also covered: the fifth terminal write, `markRunFailed`, which
 * shipped unguarded and overwrote `cancelled` with `failed` (D1); and the
 * superseded classification, which labelled a reclaim+terminal compound
 * `terminal` when `reclaim` is the actionable half (D3).
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable migrated Postgres.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-cancel-race-";
const createdUserIds: string[] = [];
const STEP = "chat-turn";
const CANCEL_ADVANCE_SLUG = "__test-cancel-race-advance";
const CANCEL_THROW_SLUG = "__test-cancel-race-throw";
const CANCEL_CLOSURE_SLUG = "__test-cancel-race-closure";
const TERMINAL_SKIP_REASON = "run_already_terminal";
const RECLAIM_SKIP_REASON = "superseded_by_reclaim";

/** Which `onTerminal` branch fired. Mirrors the runtime's `TerminalOutcome` discriminant. */
type TerminalRunOutcome = "failed" | "cancelled";

/**
 * Every closure-hook invocation the closure workflow saw, in order. `outcome`
 * records WHICH branch fired: a cancel rendered as a failure would put a
 * retryable error on a turn the user deliberately ended, so the two are asserted
 * apart, not merged.
 */
const terminalCalls: { runId: string; outcome: TerminalRunOutcome; reason: string }[] = [];

/** A step that is cancelled while it runs, then returns a normal `next`. */
const cancelThenAdvanceWorkflow: Workflow<Record<string, never>> = {
  slug: CANCEL_ADVANCE_SLUG,
  name: "cancel race advance test",
  trigger: { kind: "manual" },
  initialState: () => ({}),
  initialStep: STEP,
  closure: { kind: "none" },
  steps: {
    [STEP]: {
      id: STEP,
      run: async (ctx): Promise<StepResult<Record<string, never>>> => {
        await cancelRun({ runId: ctx.runId, reason: "user_stopped" });
        return { kind: "next", state: {}, nextStep: "dispatch-tools" };
      },
    },
  },
};

/** A step that is cancelled while it runs, then throws. */
const cancelThenThrowWorkflow: Workflow<Record<string, never>> = {
  slug: CANCEL_THROW_SLUG,
  name: "cancel race throw test",
  trigger: { kind: "manual" },
  initialState: () => ({}),
  initialStep: STEP,
  closure: { kind: "none" },
  steps: {
    [STEP]: {
      id: STEP,
      run: async (ctx): Promise<StepResult<Record<string, never>>> => {
        await cancelRun({ runId: ctx.runId, reason: "user_stopped" });
        throw new Error("step exploded after the cancel");
      },
    },
  },
};

/**
 * Stands in for chat-turn: a workflow that owes the client closure when its run
 * goes terminal outside the step body. Recording the hook's branch rather than
 * driving chat-turn keeps the assertion on the *runtime* obligation and off
 * chat-turn's finalizers (which would want a thread, a message row, and a model
 * call for the thread title).
 */
const cancelClosureWorkflow: Workflow<Record<string, never>> = {
  slug: CANCEL_CLOSURE_SLUG,
  name: "cancel race closure test",
  trigger: { kind: "manual" },
  initialState: () => ({}),
  initialStep: STEP,
  steps: {
    [STEP]: {
      id: STEP,
      run: async (ctx): Promise<StepResult<Record<string, never>>> => {
        await cancelRun({ runId: ctx.runId, reason: "user_stopped" });
        return { kind: "next", state: {}, nextStep: "dispatch-tools" };
      },
    },
  },
  closure: {
    kind: "client",
    async onTerminal(ctx) {
      terminalCalls.push({
        runId: ctx.runId,
        outcome: ctx.outcome,
        reason: ctx.outcome === "failed" ? ctx.error : ctx.reason,
      });
    },
  },
};

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test", email: `${userId}@example.test` });
  return userId;
}

async function seedRun(args: {
  workflowSlug: string;
  status: "runnable" | "running" | "waiting";
  attempt: number;
  withStepRow?: boolean;
}): Promise<{ userId: string; runId: string }> {
  const userId = await seedUser();
  const runId = `run_${randomUUID().slice(0, 12)}`;
  await db().insert(agentRuns).values({
    id: runId,
    userId,
    workflowSlug: args.workflowSlug,
    currentStep: STEP,
    status: args.status,
    attempt: args.attempt,
    lastCheckpointAt: new Date(),
  });
  if (args.withStepRow) {
    await db()
      .insert(agentSteps)
      .values({ runId, stepId: STEP, attempt: args.attempt, status: "running" });
  }
  return { userId, runId };
}

/**
 * A sub-agent child of `parentRunId`, owned by the same user. Only the
 * `subAgent` metadata makes it a child — that pointer is what the cascade
 * (and `listSpawnedChildRuns`) reads.
 */
async function seedChildRun(args: {
  userId: string;
  parentRunId: string;
  status: "runnable" | "running" | "waiting" | "completed";
  subId: string;
}): Promise<string> {
  const runId = `run_child_${randomUUID().slice(0, 12)}`;
  await db()
    .insert(agentRuns)
    .values({
      id: runId,
      userId: args.userId,
      workflowSlug: CANCEL_CLOSURE_SLUG,
      currentStep: STEP,
      status: args.status,
      attempt: 1,
      lastCheckpointAt: new Date(),
      metadata: {
        subAgent: {
          kind: "sub_agent",
          parentRunId: args.parentRunId,
          subId: args.subId,
          parentToolCallId: `call_${args.subId}`,
        },
      },
    });
  return runId;
}

/** A pending approval staging, so a resurrected interrupt would be visibly wrong. */
async function seedPendingStaging(userId: string, runId: string): Promise<string> {
  const rows = await db()
    .insert(actionStagings)
    .values({
      userId,
      runId,
      stepId: STEP,
      toolCallId: `call_${randomUUID().slice(0, 8)}`,
      toolName: "gmail.send_email",
      integration: "gmail",
      riskTier: "high",
      proposedInput: {},
      proposedInputHash: "hash",
      requiresApproval: true,
      status: "pending",
      effectKey: `eff:${runId}:call_${randomUUID().slice(0, 8)}`,
      attemptKey: `eff:${runId}:call_${randomUUID().slice(0, 8)}:1`,
      requestHash: "req:test-cancel-race",
    })
    .returning({ id: actionStagings.id });
  const id = rows[0]?.id;
  assert.ok(id, "seeded a staging row");
  return id;
}

function runRow(userId: string, runId: string, workflowSlug: string, attempt: number) {
  return {
    id: runId,
    userId,
    workflowSlug,
    status: "running" as const,
    state: {},
    transcript: [],
    currentStep: STEP,
    attempt,
    cancellationGeneration: 0,
    metadata: {},
  };
}

async function readRun(runId: string) {
  const rows = await db()
    .select({
      status: agentRuns.status,
      currentStep: agentRuns.currentStep,
      attempt: agentRuns.attempt,
      wakeCondition: agentRuns.wakeCondition,
      error: agentRuns.error,
      endedAt: agentRuns.endedAt,
      cancellationGeneration: agentRuns.cancellationGeneration,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  return rows[0];
}

async function countApprovalRequests(userId: string): Promise<number> {
  const rows = await db()
    .select({ id: eventsOutbox.id })
    .from(eventsOutbox)
    .where(and(eq(eventsOutbox.userId, userId), eq(eventsOutbox.kind, "approval.requested")));
  return rows.length;
}

/**
 * The terminal `agent.run`/`failed` frames this run emitted. `markRunFailed`
 * releases the client's replay barrier by publishing one such frame in the same
 * tx as the `failed` status write, so a superseded (rolled-back) write must
 * leave zero.
 */
async function readFailedRunFrames(userId: string, runId: string): Promise<unknown[]> {
  const rows = await db()
    .select({ payload: eventsOutbox.payload })
    .from(eventsOutbox)
    .where(and(eq(eventsOutbox.userId, userId), eq(eventsOutbox.kind, "agent.run")));
  return rows
    .map((r) => r.payload)
    .filter((p) => getStringPath(p, "runId") === runId && getStringPath(p, "phase") === "failed");
}

/**
 * The `error` string carried by this run's `agent.run`/`cancelled` frame, if
 * any. `cancelRunInTx` mints it through `boundAgentRunError`, so it is bounded
 * to `AGENT_RUN_ERROR_MAX` even when the caller's `reason` is longer — otherwise
 * `publishEvent`'s `safeParse` would throw on the over-cap string.
 */
async function readCancelledFrameError(userId: string, runId: string): Promise<string | undefined> {
  const rows = await db()
    .select({ payload: eventsOutbox.payload })
    .from(eventsOutbox)
    .where(and(eq(eventsOutbox.userId, userId), eq(eventsOutbox.kind, "agent.run")));
  const frame = rows
    .map((r) => r.payload)
    .find((p) => getStringPath(p, "runId") === runId && getStringPath(p, "phase") === "cancelled");
  return frame === undefined ? undefined : getStringPath(frame, "error");
}

async function readStagingStatuses(runId: string): Promise<string[]> {
  const rows = await db()
    .select({ status: actionStagings.status })
    .from(actionStagings)
    .where(eq(actionStagings.runId, runId));
  return rows.map((r) => r.status);
}

describe("mid-flight cancel race (#530, DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
    if (!getWorkflow(CANCEL_ADVANCE_SLUG)) registerRecipe(cancelThenAdvanceWorkflow);
    if (!getWorkflow(CANCEL_THROW_SLUG)) registerRecipe(cancelThenThrowWorkflow);
    if (!getWorkflow(CANCEL_CLOSURE_SLUG)) registerRecipe(cancelClosureWorkflow);
  });
  beforeEach(() => {
    terminalCalls.length = 0;
  });
  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    _resetRegistryForTests();
    await closeConnections();
    await closeRedis();
  });

  test("a cancel during the step body survives the step's `next` commit", async () => {
    const { runId } = await seedRun({
      workflowSlug: CANCEL_ADVANCE_SLUG,
      status: "runnable",
      attempt: 5,
    });

    const outcome = await runOnce(runId);

    assert.equal(outcome.kind, "skipped", "the commit onto a cancelled run is a benign skip");
    assert.equal(
      outcome.kind === "skipped" ? outcome.reason : undefined,
      TERMINAL_SKIP_REASON,
      "and is reported as a terminal-status miss, not a lease reclaim",
    );
    const run = await readRun(runId);
    assert.equal(run?.status, "cancelled", "the run is NOT resurrected to runnable");
    assert.equal(run?.currentStep, STEP, "the run did NOT advance to the next step");
    assert.equal(run?.attempt, 5, "the stale commit did not bump the attempt");
  });

  test("a cancel during the step body survives a step throw (no terminal-fail rewrite)", async () => {
    const { runId } = await seedRun({
      workflowSlug: CANCEL_THROW_SLUG,
      status: "runnable",
      attempt: 2,
    });

    const outcome = await runOnce(runId);

    assert.equal(outcome.kind, "skipped");
    assert.equal(outcome.kind === "skipped" ? outcome.reason : undefined, TERMINAL_SKIP_REASON);
    const run = await readRun(runId);
    assert.equal(run?.status, "cancelled", "the cancel reason is preserved over `failed`");
  });

  test("a cancelled run is not completed by a late `done` commit", async () => {
    const { userId, runId } = await seedRun({
      workflowSlug: CANCEL_CLOSURE_SLUG,
      status: "running",
      attempt: 3,
      withStepRow: true,
    });
    await cancelRun({ runId, reason: "user_stopped" });

    const outcome = await commitStepSuccess(
      runRow(userId, runId, CANCEL_CLOSURE_SLUG, 3),
      STEP,
      3,
      { kind: "done", state: {}, output: { messageId: "msg_x" } },
      [],
      [],
    );

    assert.equal(outcome.kind, "skipped");
    assert.equal(outcome.kind === "skipped" ? outcome.reason : undefined, TERMINAL_SKIP_REASON);
    assert.equal((await readRun(runId))?.status, "cancelled");
    assert.deepEqual(
      terminalCalls,
      [{ runId, outcome: "cancelled", reason: "user_stopped" }],
      "the cancel closed the turn even though the late `done` commit was refused",
    );
  });

  test("#559b: cancel advances the fence and preserves committed effects", async () => {
    const { userId, runId } = await seedRun({
      workflowSlug: CANCEL_CLOSURE_SLUG,
      status: "running",
      attempt: 1,
    });

    // A pending approval the cancel must reject…
    await seedPendingStaging(userId, runId);
    // …and two committed effects the cancel must NOT touch: one `succeeded`
    // and one stuck at the sticky `unknown` outcome. The ambiguity barrier
    // keys on the unknown row, so a cancel rewriting it would erase the
    // possibly-delivered protection for a later identical proposal.
    for (const [suffix, outcome] of [
      ["done", "succeeded"],
      ["unknown", "unknown"],
    ] as const) {
      await db()
        .insert(actionStagings)
        .values({
          userId,
          runId,
          stepId: STEP,
          toolCallId: `call_${suffix}`,
          toolName: "gmail.send_email",
          integration: "gmail",
          riskTier: "high",
          proposedInput: {},
          proposedInputHash: `hash_${suffix}`,
          requestHash: `req:${suffix}`,
          requiresApproval: true,
          status: "executed",
          outcome,
          effectKey: `eff:${runId}:call_${suffix}`,
          attemptKey: `eff:${runId}:call_${suffix}:1`,
          executedAt: new Date(),
        });
    }

    assert.equal(await cancelRun({ runId, reason: "user_stopped" }), "cancelled");

    const run = await readRun(runId);
    assert.equal(run?.status, "cancelled");
    assert.equal(run?.cancellationGeneration, 1, "#559b: the fence advanced exactly once");

    const rows = await db()
      .select({
        toolCallId: actionStagings.toolCallId,
        status: actionStagings.status,
        outcome: actionStagings.outcome,
        rejectReason: actionStagings.rejectReason,
      })
      .from(actionStagings)
      .where(eq(actionStagings.runId, runId));

    const pendingRow = rows.find(
      (r) => r.toolCallId !== "call_done" && r.toolCallId !== "call_unknown",
    );
    const doneRow = rows.find((r) => r.toolCallId === "call_done");
    const unknownRow = rows.find((r) => r.toolCallId === "call_unknown");

    assert.equal(pendingRow?.status, "rejected", "the pending approval is rejected by cancel");
    assert.equal(pendingRow?.rejectReason, "user_stopped", "the rejection records the cancel");
    assert.equal(doneRow?.status, "executed", "a completed effect is preserved");
    assert.equal(
      unknownRow?.status,
      "executed",
      "an unknown-outcome effect is preserved — the ambiguity barrier must keep blocking",
    );
    assert.equal(rows.length, 3);
  });

  test("a cancelled run does not re-fire approval.requested from a late interrupt commit", async () => {
    const { userId, runId } = await seedRun({
      workflowSlug: CANCEL_CLOSURE_SLUG,
      status: "running",
      attempt: 4,
      withStepRow: true,
    });
    await seedPendingStaging(userId, runId);
    await cancelRun({ runId, reason: "user_stopped" });
    assert.deepEqual(
      await readStagingStatuses(runId),
      ["rejected"],
      "the cancel rejected the pending staging",
    );

    const outcome = await commitStepSuccess(
      runRow(userId, runId, CANCEL_CLOSURE_SLUG, 4),
      STEP,
      4,
      {
        kind: "interrupt",
        state: {},
        wake: { kind: "hil", approvalId: `ap_${randomUUID().slice(0, 8)}`, prompt: "Approve?" },
      },
      [],
      [],
    );

    assert.equal(outcome.kind, "skipped");
    assert.equal(outcome.kind === "skipped" ? outcome.reason : undefined, TERMINAL_SKIP_REASON);
    assert.equal(
      await countApprovalRequests(userId),
      0,
      "no approval was requested on a cancelled run whose stagings are already rejected",
    );
    const run = await readRun(runId);
    assert.equal(run?.status, "cancelled", "the run is NOT parked back into waiting");
    assert.equal(run?.wakeCondition, null, "the cancel's nulled wake condition survives");
    assert.deepEqual(await readStagingStatuses(runId), ["rejected"]);
  });

  test("a staging that commits after cancellation is swept when the executor loses", async () => {
    const { userId, runId } = await seedRun({
      workflowSlug: CANCEL_CLOSURE_SLUG,
      status: "running",
      attempt: 6,
      withStepRow: true,
    });
    await cancelRun({ runId, reason: "user_stopped" });

    // This is the D1 ordering: the cancel transaction already committed and
    // completed its first sweep, then the still-live step body's independent
    // staging autocommit lands.
    await seedPendingStaging(userId, runId);
    assert.deepEqual(await readStagingStatuses(runId), ["pending"]);

    const outcome = await commitStepSuccess(
      runRow(userId, runId, CANCEL_CLOSURE_SLUG, 6),
      STEP,
      6,
      {
        kind: "interrupt",
        state: {},
        wake: { kind: "hil", approvalId: "late", prompt: "Approve?" },
      },
      [],
      [],
    );

    assert.equal(outcome.kind, "skipped");
    assert.deepEqual(
      await readStagingStatuses(runId),
      ["rejected"],
      "the losing executor compensates the staging row its tx could not roll back",
    );
  });

  // ---- D2: refusing the commit must not mean nothing closes the turn --------

  test("a mid-step cancel closes the client turn exactly once", async () => {
    const { runId } = await seedRun({
      workflowSlug: CANCEL_CLOSURE_SLUG,
      status: "runnable",
      attempt: 1,
    });

    const outcome = await runOnce(runId);

    assert.equal(outcome.kind, "skipped", "the commit still rolls back");
    assert.equal(outcome.kind === "skipped" ? outcome.reason : undefined, TERMINAL_SKIP_REASON);
    assert.deepEqual(
      terminalCalls,
      [{ runId, outcome: "cancelled", reason: "user_stopped" }],
      "the cancel drove workflow closure once, with a `cancelled` outcome (not `failed`)",
    );
  });

  test("a waiting-state cancel closes the client turn too", async () => {
    // The pre-existing half of the same gap: a run parked on an approval never
    // enters a step body at all, so nothing but the cancel path can close it.
    const { runId } = await seedRun({
      workflowSlug: CANCEL_CLOSURE_SLUG,
      status: "waiting",
      attempt: 2,
    });

    assert.equal(await cancelRun({ runId, reason: "cancelled_by_user" }), "cancelled");

    assert.deepEqual(terminalCalls, [{ runId, outcome: "cancelled", reason: "cancelled_by_user" }]);
  });

  test("a cancel reason over the cap publishes a bounded frame, not a safeParse throw", async () => {
    // The live instance item 66 closes: `cancelRunInTx` publishes the reason on
    // the length-capped `agent.run` frame. An over-cap reason used to make
    // `publishEvent`'s `safeParse` throw inside the tx; `boundAgentRunError`
    // bounds it. Reason is `CancelRunArgs.reason: string` with no cap of its own.
    const { userId, runId } = await seedRun({
      workflowSlug: CANCEL_CLOSURE_SLUG,
      status: "running",
      attempt: 3,
    });
    const longReason = "x".repeat(AGENT_RUN_ERROR_MAX + 500);

    // Would reject (throw) on the over-cap payload without the publisher clamp.
    assert.equal(await cancelRun({ runId, reason: longReason }), "cancelled");

    const frameError = await readCancelledFrameError(userId, runId);
    assert.ok(frameError !== undefined, "the cancelled frame was published");
    assert.ok(
      frameError.length <= AGENT_RUN_ERROR_MAX,
      `frame error bounded to the cap (was ${frameError.length})`,
    );
  });

  // ---- #559b: the cancel reaches the children the boss delegated to --------

  test("#559b: cancelling a parent cascades to its non-terminal sub-agent children", async () => {
    const { userId, runId } = await seedRun({
      workflowSlug: CANCEL_CLOSURE_SLUG,
      status: "running",
      attempt: 1,
    });
    const running = await seedChildRun({
      userId,
      parentRunId: runId,
      status: "running",
      subId: "a",
    });
    const parked = await seedChildRun({
      userId,
      parentRunId: runId,
      status: "waiting",
      subId: "b",
    });
    const finished = await seedChildRun({
      userId,
      parentRunId: runId,
      status: "completed",
      subId: "c",
    });
    // A child of a DIFFERENT parent. The cascade selects on the metadata
    // pointer, so a predicate that fell back to "every sub-agent run of this
    // user" would kill this one too.
    const other = await seedRun({
      workflowSlug: CANCEL_CLOSURE_SLUG,
      status: "running",
      attempt: 1,
    });
    const stranger = await seedChildRun({
      userId,
      parentRunId: other.runId,
      status: "running",
      subId: "d",
    });

    assert.equal(await cancelRun({ runId, reason: "user_stopped" }), "cancelled");

    for (const [childRunId, label] of [
      [running, "a running child"],
      [parked, "a parked child"],
    ] as const) {
      const child = await readRun(childRunId);
      assert.equal(child?.status, "cancelled", `${label} is cancelled with its parent`);
      assert.equal(
        getStringPath(child?.error, "reason"),
        "parent_run_cancelled",
        `${label} records WHY it stopped, not the parent's own reason`,
      );
      assert.equal(
        child?.cancellationGeneration,
        1,
        `${label} advanced its OWN fence — its dispatch gate reads no other`,
      );
    }

    const done = await readRun(finished);
    assert.equal(done?.status, "completed", "a child that already finished is left alone");
    assert.equal(done?.cancellationGeneration, 0, "…and its fence never moved");

    const untouched = await readRun(stranger);
    assert.equal(untouched?.status, "running", "another parent's child keeps running");
  });

  test("#559b: a cascaded child discharges its own cancel obligations", async () => {
    // The child's obligations ride back inside the parent's `afterCommit`
    // closure. If they were dropped, the child's client turn would stream
    // forever — the same D2 hole this file closes for a directly cancelled run.
    const { userId, runId } = await seedRun({
      workflowSlug: CANCEL_CLOSURE_SLUG,
      status: "running",
      attempt: 1,
    });
    const childRunId = await seedChildRun({
      userId,
      parentRunId: runId,
      status: "running",
      subId: "closes",
    });
    // A pending approval on the CHILD. The parent's bulk reject is scoped to
    // its own run id, so only the cascade can decide this row.
    await seedPendingStaging(userId, childRunId);

    assert.equal(
      await cancelRun({
        runId,
        reason: "user_stopped",
        pendingApprovalRejectReason: "You stopped this run.",
      }),
      "cancelled",
    );

    assert.deepEqual(
      terminalCalls,
      [
        { runId, outcome: "cancelled", reason: "user_stopped" },
        { runId: childRunId, outcome: "cancelled", reason: "parent_run_cancelled" },
      ],
      "the parent closes its own turn first, then the child closes its trail",
    );
    assert.deepEqual(
      await readStagingStatuses(childRunId),
      ["rejected"],
      "the child's pending approval is rejected too",
    );
    const [rejected] = await db()
      .select({ reason: actionStagings.rejectReason })
      .from(actionStagings)
      .where(eq(actionStagings.runId, childRunId));
    assert.equal(
      rejected?.reason,
      "You stopped this run.",
      "the user-facing text stays the parent's — the user decided once, about one run",
    );
  });

  test("#559b: a cancelled parent may not spawn a fresh child", async () => {
    // The other half of the cascade. Cancelling reaches the children that
    // exist; this is what stops a new one being born a moment later, when the
    // parent's step body runs on past the cancel and calls `spawn_sub_agent`.
    const { userId, runId } = await seedRun({
      workflowSlug: CANCEL_CLOSURE_SLUG,
      status: "running",
      attempt: 1,
    });
    await cancelRun({ runId, reason: "user_stopped" });

    await assert.rejects(
      () =>
        spawnSubAgent({
          parentRunId: runId,
          userId,
          parentToolCallId: "call_late",
          subId: "late",
          brief: "do the thing anyway",
          allowedIntegrations: [],
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error, `spawn rejected with ${String(error)}`);
        assert.match(error.message, /is cancelled; it may not spawn/);
        return true;
      },
      "a terminal parent must not gain a child",
    );

    const children = await db()
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(sql`${agentRuns.metadata}->'subAgent'->>'parentRunId' = ${runId}`);
    assert.deepEqual(children, [], "no child row was written");
  });

  test("cancelling an already-terminal run does not re-close the turn", async () => {
    const { runId } = await seedRun({
      workflowSlug: CANCEL_CLOSURE_SLUG,
      status: "waiting",
      attempt: 0,
    });
    await cancelRun({ runId, reason: "first" });
    terminalCalls.length = 0;

    assert.equal(await cancelRun({ runId, reason: "second" }), "already_terminal");

    assert.deepEqual(terminalCalls, [], "no second closure for a no-op cancel");
  });

  // ---- D1: markRunFailed is a terminal write and must be guarded -----------

  test("markRunFailed refuses to overwrite a cancelled run with failed", async () => {
    const { userId, runId } = await seedRun({
      workflowSlug: CANCEL_CLOSURE_SLUG,
      status: "running",
      attempt: 7,
    });
    await cancelRun({ runId, reason: "cancelled_by_user" });
    const cancelled = await readRun(runId);
    terminalCalls.length = 0;

    // The window `runOnce` hits when a post-deploy step-resolution failure races
    // a cancel: leased at attempt 7, cancel lands, then the resolve throws.
    const cause = await markRunFailed(
      runRow(userId, runId, CANCEL_CLOSURE_SLUG, 7),
      STEP,
      7,
      "no step registered; deploy mismatch?",
    );

    assert.equal(
      cause,
      "terminal",
      "reported as superseded so the caller skips instead of failing",
    );
    const run = await readRun(runId);
    assert.equal(run?.status, "cancelled", "the run is NOT rewritten to failed");
    assert.deepEqual(run?.error, cancelled?.error, "the cancel's reason payload is intact");
    assert.deepEqual(run?.endedAt, cancelled?.endedAt, "and so is its endedAt");
    assert.deepEqual(terminalCalls, [], "and no failure closure ran on a cancelled turn");
    // The release frame rides the same tx as the guarded `failed` write, so the
    // supersede rollback drops it — a leaked `failed` frame over a `cancelled`
    // run is the #530 class the guard exists to prevent.
    assert.deepEqual(
      await readFailedRunFrames(userId, runId),
      [],
      "no agent.run/failed frame leaked over the cancelled run",
    );
  });

  test("markRunFailed still lands on a run this worker owns", async () => {
    const { userId, runId } = await seedRun({
      workflowSlug: CANCEL_CLOSURE_SLUG,
      status: "running",
      attempt: 1,
    });

    const cause = await markRunFailed(
      runRow(userId, runId, CANCEL_CLOSURE_SLUG, 1),
      STEP,
      1,
      "no step registered; deploy mismatch?",
    );

    assert.equal(cause, null, "not superseded");
    assert.equal((await readRun(runId))?.status, "failed");
    // The terminal `agent.run`/`failed` frame that releases the client's
    // replay barrier — published in the same tx as the `failed` status write.
    assert.equal(
      (await readFailedRunFrames(userId, runId)).length,
      1,
      "exactly one terminal agent.run/failed frame for the run",
    );
  });

  test("markRunFailed bounds an over-4000-char error so the terminal write commits", async () => {
    const { userId, runId } = await seedRun({
      workflowSlug: CANCEL_CLOSURE_SLUG,
      status: "running",
      attempt: 1,
    });

    // A resolve-failure message longer than the `agent.run` frame's `error` cap.
    // On `main` this makes `publishEvent`'s `safeParse` throw INSIDE the guarded
    // tx, rolling the `failed` write back so the run stays `running` and
    // re-enters the reclaim loop. The bound at the sanitize sink is what lets the
    // terminal write commit.
    const cause = await markRunFailed(
      runRow(userId, runId, CANCEL_CLOSURE_SLUG, 1),
      STEP,
      1,
      "z".repeat(AGENT_RUN_ERROR_MAX + 500),
    );

    assert.equal(cause, null, "not superseded");
    const run = await readRun(runId);
    assert.equal(run?.status, "failed", "reaches terminal failed, not stuck running");

    const frames = await readFailedRunFrames(userId, runId);
    assert.equal(frames.length, 1, "exactly one terminal agent.run/failed frame");

    const frameError = getStringPath(frames[0], "error");
    const persisted = getStringPath(run?.error, "message");
    assert.ok(frameError !== undefined, "the frame carries the bounded error");
    assert.ok(frameError.length <= AGENT_RUN_ERROR_MAX, "frame error is within the cap");
    assert.equal(
      frameError,
      persisted,
      "the frame error and the persisted error.message are the identical bounded string",
    );
  });

  // ---- D3: a compound supersede reports the actionable cause ---------------

  test("a reclaim that also completed the run classifies as a reclaim", async () => {
    // Worker A ran a long step at attempt 3; the sweep reclaimed to 4 and worker
    // B finished the run. BOTH halves of A's guard now fail. `reclaim` is the
    // half worth reporting — it means a duplicate full-price model call and a
    // stale window to tune, where `run_already_terminal` reads as "the user
    // cancelled" and closes the investigation.
    const { userId, runId } = await seedRun({
      workflowSlug: CANCEL_CLOSURE_SLUG,
      status: "running",
      attempt: 3,
      withStepRow: true,
    });
    await db()
      .update(agentRuns)
      .set({ attempt: 4, status: "completed" })
      .where(eq(agentRuns.id, runId));

    const outcome = await commitStepSuccess(
      runRow(userId, runId, CANCEL_CLOSURE_SLUG, 3),
      STEP,
      3,
      { kind: "next", state: {}, nextStep: "dispatch-tools" },
      [],
      [],
    );

    assert.equal(outcome.kind, "skipped");
    assert.equal(
      outcome.kind === "skipped" ? outcome.reason : undefined,
      RECLAIM_SKIP_REASON,
      "the reclaim is reported, not the terminal status it left behind",
    );
    const run = await readRun(runId);
    assert.equal(run?.status, "completed", "and the winner's terminal status is untouched");
    assert.equal(run?.attempt, 4);
  });
});
