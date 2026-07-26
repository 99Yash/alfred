import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { actionStagings, agentRuns, agentSteps, eventsOutbox, user } from "@alfred/db/schemas";
import { and, eq, inArray, like } from "drizzle-orm";

import { closeRedis } from "../../src/queue/connection";
import { commitStepSuccess, markRunFailed, runOnce } from "../../src/modules/agent/executor";
import {
  _resetRegistryForTests,
  getWorkflow,
  registerWorkflow,
} from "../../src/modules/agent/registry";
import { cancelRun } from "../../src/modules/agent/service";
import type { StepResult, Workflow } from "../../src/modules/agent/types";

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
const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

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
    if (!getWorkflow(CANCEL_ADVANCE_SLUG)) registerWorkflow(cancelThenAdvanceWorkflow);
    if (!getWorkflow(CANCEL_THROW_SLUG)) registerWorkflow(cancelThenThrowWorkflow);
    if (!getWorkflow(CANCEL_CLOSURE_SLUG)) registerWorkflow(cancelClosureWorkflow);
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
