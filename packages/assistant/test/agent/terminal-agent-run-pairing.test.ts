import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { getStringPath, isTerminalStatus, TERMINAL_RUN_STATUSES } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { agentRuns, eventsOutbox, user } from "@alfred/db/schemas";
import { and, eq, inArray, like } from "drizzle-orm";

import { commitStepSuccess, markRunFailed, runOnce } from "@alfred/assistant/execution/executor";
import {
  _resetRegistryForTests,
  getWorkflow,
  registerRecipe,
} from "@alfred/assistant/execution/registry";
import type { StepResult, Workflow } from "@alfred/assistant/execution";
import { dbBackedSkip } from "../support/db-backed";

/**
 * A non-chat run with a terminal status must also have a terminal `agent.run`
 * frame, or the client's replay barrier never releases. The publish is a
 * separate write after the guard, so only the persisted rows show the pairing.
 * Cancel and the lease backstop bypass the guard and are out of scope.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-terminal-pairing-";

const createdUserIds: string[] = [];

const STEP = "chat-turn";

const THROW_SLUG = "__test-terminal-pairing-throw";

/** A non-chat workflow whose step throws. */
const throwWorkflow: Workflow<Record<string, never>> = {
  slug: THROW_SLUG,
  name: "terminal pairing throw test",
  trigger: { kind: "manual" },
  initialState: () => ({}),
  initialStep: STEP,
  closure: { kind: "none" },
  steps: {
    [STEP]: {
      id: STEP,
      run: async (): Promise<StepResult<Record<string, never>>> => {
        throw new Error("step exploded for the terminal-pairing test");
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
  status: "runnable" | "running" | "failed";
  attempt: number;
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

  return { userId, runId };
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

async function readStatus(runId: string) {
  const rows = await db()
    .select({ status: agentRuns.status })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));

  return rows[0]?.status;
}

const TERMINAL_PHASES: readonly string[] = TERMINAL_RUN_STATUSES;

async function assertTerminalRunEmitsTerminalFrame(userId: string, runId: string): Promise<void> {
  const status = await readStatus(runId);
  assert.ok(status, `run ${runId} exists`);

  if (!isTerminalStatus(status)) return;

  const rows = await db()
    .select({ payload: eventsOutbox.payload })
    .from(eventsOutbox)
    .where(and(eq(eventsOutbox.userId, userId), eq(eventsOutbox.kind, "agent.run")));

  const hasTerminalFrame = rows.some((r) => {
    const phase = getStringPath(r.payload, "phase");

    return (
      getStringPath(r.payload, "runId") === runId &&
      phase !== undefined &&
      TERMINAL_PHASES.includes(phase)
    );
  });

  assert.ok(
    hasTerminalFrame,
    `run ${runId} committed terminal status "${status}" but published no terminal agent.run frame`,
  );
}

describe("terminal run ⟹ terminal agent.run frame (item 56, DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));

    if (!getWorkflow(THROW_SLUG)) registerRecipe(throwWorkflow);
  });
  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }

    _resetRegistryForTests();
    await closeConnections();
  });

  test("done→completed pairs a terminal agent.run frame", async () => {
    const { userId, runId } = await seedRun({
      workflowSlug: THROW_SLUG,
      status: "running",
      attempt: 1,
    });

    const outcome = await commitStepSuccess(
      runRow(userId, runId, THROW_SLUG, 1),
      STEP,
      1,
      { kind: "done", state: {}, output: { ok: true } },
      [],
      [],
    );

    assert.equal(outcome.kind, "completed");
    assert.equal(await readStatus(runId), "completed");
    await assertTerminalRunEmitsTerminalFrame(userId, runId);
  });

  test("blocked→blocked pairs a terminal agent.run frame", async () => {
    const { userId, runId } = await seedRun({
      workflowSlug: THROW_SLUG,
      status: "running",
      attempt: 1,
    });

    const outcome = await commitStepSuccess(
      runRow(userId, runId, THROW_SLUG, 1),
      STEP,
      1,
      { kind: "blocked", state: {}, output: { reason: "action required" } },
      [],
      [],
    );

    assert.equal(outcome.kind, "blocked");
    assert.equal(await readStatus(runId), "blocked");
    await assertTerminalRunEmitsTerminalFrame(userId, runId);
  });

  test("an in-step throw→failed pairs a terminal agent.run frame", async () => {
    const { userId, runId } = await seedRun({
      workflowSlug: THROW_SLUG,
      status: "runnable",
      attempt: 0,
    });

    const outcome = await runOnce(runId);

    assert.equal(outcome.kind, "failed");
    assert.equal(await readStatus(runId), "failed");
    await assertTerminalRunEmitsTerminalFrame(userId, runId);
  });

  test("the resolve-failure path (markRunFailed)→failed pairs a terminal agent.run frame", async () => {
    // regression: PR #656
    const { userId, runId } = await seedRun({
      workflowSlug: THROW_SLUG,
      status: "running",
      attempt: 1,
    });

    const cause = await markRunFailed(
      runRow(userId, runId, THROW_SLUG, 1),
      STEP,
      1,
      "no step registered; deploy mismatch?",
    );

    assert.equal(cause, null, "the failure landed on a run this worker owns");
    assert.equal(await readStatus(runId), "failed");
    await assertTerminalRunEmitsTerminalFrame(userId, runId);
  });

  // Proves the helper can fail.
  test("the helper fails a terminal run that published no terminal frame", async () => {
    const { userId, runId } = await seedRun({
      workflowSlug: THROW_SLUG,
      status: "failed",
      attempt: 1,
    });

    await assert.rejects(
      assertTerminalRunEmitsTerminalFrame(userId, runId),
      /published no terminal agent\.run frame/,
      "a terminal status with no paired frame is the leak this test pins",
    );
  });
});
