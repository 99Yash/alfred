import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { agentRuns, agentSteps, user } from "@alfred/db/schemas";
import { and, eq, inArray, like } from "drizzle-orm";

import { commitStepSuccess } from "../../src/modules/agent/executor";

/**
 * DB-backed tests for the commit attempt-guard. A stale-lease reclaim bumps
 * `agent_runs.attempt`, so the original worker (which leased the lower attempt)
 * and the reclaimer run the same step concurrently. The `(run,step,attempt)`
 * unique index protects the step ROWS, but they carry different attempts — so
 * without an attempt-guarded `agent_runs` UPDATE the original's late commit
 * would double-advance the run / overwrite the reclaimer's transcript. The
 * guard makes the superseded commit match 0 rows → roll back → benign skip.
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable migrated Postgres.
 */
const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

const ID_PREFIX = "test-commit-guard-";
const createdUserIds: string[] = [];
const STEP = "chat-turn";

async function seedRunningRun(attempt: number): Promise<{ userId: string; runId: string }> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test", email: `${userId}@example.test` });
  const runId = `run_${randomUUID().slice(0, 12)}`;
  await db().insert(agentRuns).values({
    id: runId,
    userId,
    workflowSlug: "chat",
    currentStep: STEP,
    status: "running",
    attempt,
    lastCheckpointAt: new Date(),
  });
  await db().insert(agentSteps).values({ runId, stepId: STEP, attempt, status: "running" });
  return { userId, runId };
}

function runRow(userId: string, runId: string, attempt: number) {
  return {
    id: runId,
    userId,
    workflowSlug: "chat",
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
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  return rows[0];
}

async function readStepStatus(runId: string, attempt: number) {
  const rows = await db()
    .select({ status: agentSteps.status })
    .from(agentSteps)
    .where(
      and(
        eq(agentSteps.runId, runId),
        eq(agentSteps.stepId, STEP),
        eq(agentSteps.attempt, attempt),
      ),
    );
  return rows[0]?.status;
}

describe("commit attempt-guard (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
  });
  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeConnections();
  });

  test("happy path: a commit at the current attempt advances the run", async () => {
    const { userId, runId } = await seedRunningRun(5);
    const outcome = await commitStepSuccess(
      runRow(userId, runId, 5),
      STEP,
      5,
      { kind: "next", state: {}, nextStep: "dispatch-tools" },
      [],
      [],
    );
    assert.equal(outcome.kind, "advanced");
    const run = await readRun(runId);
    assert.equal(run?.attempt, 6, "attempt advances");
    assert.equal(run?.currentStep, "dispatch-tools", "step advances");
    assert.equal(run?.status, "runnable");
    assert.equal(await readStepStatus(runId, 5), "completed", "the step row is marked completed");
  });

  test("superseded: a commit at a stale attempt is rejected and rolls back", async () => {
    const { userId, runId } = await seedRunningRun(5);
    // Simulate a stale-lease reclaim bumping the attempt out from under us.
    await db().update(agentRuns).set({ attempt: 6 }).where(eq(agentRuns.id, runId));

    const outcome = await commitStepSuccess(
      runRow(userId, runId, 5), // we still think we hold attempt 5
      STEP,
      5,
      { kind: "next", state: { wrote: "should-not-land" }, nextStep: "dispatch-tools" },
      [],
      [],
    );

    assert.equal(outcome.kind, "skipped", "the superseded commit is a benign skip");
    assert.equal(outcome.kind === "skipped" ? outcome.reason : undefined, "superseded_by_reclaim");
    const run = await readRun(runId);
    assert.equal(run?.attempt, 6, "attempt is NOT advanced by the superseded worker");
    assert.equal(run?.currentStep, STEP, "the run did NOT advance to the next step");
    assert.equal(
      await readStepStatus(runId, 5),
      "running",
      "the step row update rolled back (not flipped to completed)",
    );
  });

  test("superseded done: a stale completion does not terminate the run", async () => {
    const { userId, runId } = await seedRunningRun(3);
    await db().update(agentRuns).set({ attempt: 4 }).where(eq(agentRuns.id, runId));

    const outcome = await commitStepSuccess(
      runRow(userId, runId, 3),
      STEP,
      3,
      { kind: "done", state: {}, output: { messageId: "msg_x" } },
      [],
      [],
    );
    assert.equal(outcome.kind, "skipped");
    const run = await readRun(runId);
    assert.equal(run?.status, "running", "the run is NOT marked completed by the stale worker");
    assert.equal(run?.attempt, 4);
  });
});
