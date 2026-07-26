import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { actionStagings, agentRuns, agentSteps, eventsOutbox, user } from "@alfred/db/schemas";
import { and, eq, inArray, like } from "drizzle-orm";

import { closeRedis } from "../../src/queue/connection";
import { commitStepSuccess, runOnce } from "../../src/modules/agent/executor";
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
 * Opt-in: runs only when `DATABASE_URL` points at a reachable migrated Postgres.
 */
const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

const ID_PREFIX = "test-cancel-race-";
const createdUserIds: string[] = [];
const STEP = "chat-turn";
const CANCEL_ADVANCE_SLUG = "__test-cancel-race-advance";
const CANCEL_THROW_SLUG = "__test-cancel-race-throw";
const TERMINAL_SKIP_REASON = "run_already_terminal";

/** A step that is cancelled while it runs, then returns a normal `next`. */
const cancelThenAdvanceWorkflow: Workflow<Record<string, never>> = {
  slug: CANCEL_ADVANCE_SLUG,
  name: "cancel race advance test",
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
};

/** A step that is cancelled while it runs, then throws. */
const cancelThenThrowWorkflow: Workflow<Record<string, never>> = {
  slug: CANCEL_THROW_SLUG,
  name: "cancel race throw test",
  trigger: { kind: "manual" },
  initialState: () => ({}),
  initialStep: STEP,
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
  status: "runnable" | "running";
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
      workflowSlug: "chat",
      status: "running",
      attempt: 3,
      withStepRow: true,
    });
    await cancelRun({ runId, reason: "user_stopped" });

    const outcome = await commitStepSuccess(
      runRow(userId, runId, "chat", 3),
      STEP,
      3,
      { kind: "done", state: {}, output: { messageId: "msg_x" } },
      [],
      [],
    );

    assert.equal(outcome.kind, "skipped");
    assert.equal(outcome.kind === "skipped" ? outcome.reason : undefined, TERMINAL_SKIP_REASON);
    assert.equal((await readRun(runId))?.status, "cancelled");
  });

  test("a cancelled run does not re-fire approval.requested from a late interrupt commit", async () => {
    const { userId, runId } = await seedRun({
      workflowSlug: "chat",
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
      runRow(userId, runId, "chat", 4),
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
});
