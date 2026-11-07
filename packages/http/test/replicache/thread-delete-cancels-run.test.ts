/**
 * SM-14: deleting a chat thread must cancel its live run. A run has no FK to its thread, so the
 * delete alone left it waiting, and a card it staged stayed decidable from `/approvals`.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { closeRedis } from "@alfred/db/redis";
import {
  actionStagings,
  agentRuns,
  CHAT_TURN_WORKFLOW_SLUG,
  chatThreads,
  user,
} from "@alfred/db/schemas";
import { eq, inArray } from "drizzle-orm";

import { handlePush } from "../../src/sync/push";
import { dbBackedSkip } from "../support/db-backed";
import { applyServerEnvFixtures } from "../support/server-env";

// `serverEnv()` memoizes, so seed first.
applyServerEnvFixtures();

const SKIP = dbBackedSkip("database+redis");

const ID_PREFIX = "test-thread-delete-run-";

const createdUserIds: string[] = [];

/** A thread whose chat run waits on one pending approval card. */
async function seedThreadWithParkedRun(): Promise<{
  userId: string;
  threadId: string;
  runId: string;
  stagingId: string;
}> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });

  const threadId = `${ID_PREFIX}t-${randomUUID()}`;
  await db().insert(chatThreads).values({ id: threadId, userId });

  const runId = `run_${randomUUID().slice(0, 12)}`;
  await db().insert(agentRuns).values({
    id: runId,
    userId,
    workflowSlug: CHAT_TURN_WORKFLOW_SLUG,
    currentStep: "dispatch-tools",
    status: "waiting",
    attempt: 1,
    state: {},
    metadata: { threadId },
    lastCheckpointAt: new Date(),
  });

  const toolCallId = `call_${randomUUID().slice(0, 8)}`;

  const [staging] = await db()
    .insert(actionStagings)
    .values({
      userId,
      runId,
      stepId: "dispatch-tools",
      toolCallId,
      toolName: "gmail.send_draft",
      integration: "gmail",
      riskTier: "high",
      proposedInput: {},
      proposedInputHash: "hash",
      requiresApproval: true,
      status: "pending",
      effectKey: `eff:${runId}:${toolCallId}`,
      attemptKey: `eff:${runId}:${toolCallId}:1`,
      requestHash: "req:test-thread-delete-run",
      outcome: "awaiting_approval",
    })
    .returning({ id: actionStagings.id });

  assert.ok(staging);

  return { userId, threadId, runId, stagingId: staging.id };
}

describe("chatThreadDelete cancels the thread's live run (DB/Redis-backed)", { skip: SKIP }, () => {
  after(async () => {
    if (createdUserIds.length) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }

    await closeRedis();
    await closeConnections();
  });

  test("the waiting run is cancelled and its pending card is rejected", async () => {
    const { userId, threadId, runId, stagingId } = await seedThreadWithParkedRun();

    const result = await handlePush(userId, {
      pushVersion: 1,
      clientGroupID: `${ID_PREFIX}g-${randomUUID()}`,
      mutations: [
        {
          id: 1,
          clientID: `${ID_PREFIX}c-${randomUUID()}`,
          name: "chatThreadDelete",
          args: { id: threadId },
          timestamp: 1,
        },
      ],
    });

    assert.deepEqual(result, {});

    const [run] = await db()
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));

    assert.equal(run?.status, "cancelled");

    const [staging] = await db()
      .select({ status: actionStagings.status, outcome: actionStagings.outcome })
      .from(actionStagings)
      .where(eq(actionStagings.id, stagingId));

    assert.equal(staging?.status, "rejected", "the card can no longer be approved");
  });
});
