import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { agentRuns, user } from "@alfred/db/schemas";
import { inArray, like } from "drizzle-orm";
import type { RunStatus } from "@alfred/contracts";

import { closeRedis } from "@alfred/db/redis";
import {
  parentRunStillOpen,
  USER_AUTHORED_BRIEF_WORKFLOW_SLUG,
} from "@alfred/assistant/execution/workflows/user-authored-brief";
import { dbBackedSkip } from "../support/db-backed";

/**
 * DB-backed test for the sub-agent republish guard (campaign item 38, 37-MF1).
 *
 * A spawned sub-agent republishes its `chat.tool` cards under the PARENT chat
 * run's `runId` (ADR-0073) on every resume or stale-lease reclaim. The client
 * arms a replay-recovery barrier on that `runId` and releases it only on the
 * parent's `chat.message/completed`. Once the parent run is terminal, no release
 * will come, so `dispatchToolsStep` must stop republishing under it.
 * `parentRunStillOpen` is that gate: it says "open" only for a run that both
 * exists and is non-terminal.
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable migrated Postgres.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-parent-liveness-";
const createdUserIds: string[] = [];

async function seedRun(status: RunStatus): Promise<{ userId: string; runId: string }> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test", email: `${userId}@example.test` });
  const runId = `run_${randomUUID().slice(0, 12)}`;
  await db().insert(agentRuns).values({
    id: runId,
    userId,
    workflowSlug: USER_AUTHORED_BRIEF_WORKFLOW_SLUG,
    currentStep: "boss-turn",
    status,
    attempt: 1,
    lastCheckpointAt: new Date(),
    state: {},
  });
  return { userId, runId };
}

describe("parentRunStillOpen (campaign 38, 37-MF1, DB-backed)", { skip: SKIP }, () => {
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
    await closeRedis();
  });

  // A live parent is still building its turn, so its bubble can still absorb the
  // republished card and its own `completed` will release the barrier.
  for (const status of ["running", "waiting", "pending"] as const) {
    test(`open when the parent run is ${status}`, async () => {
      const { userId, runId } = await seedRun(status);
      assert.equal(await parentRunStillOpen(runId, userId), true);
    });
  }

  // A terminal parent will never publish `completed` again, so a card
  // republished under it arms a barrier nothing releases.
  for (const status of ["completed", "cancelled", "failed"] as const) {
    test(`closed when the parent run is ${status}`, async () => {
      const { userId, runId } = await seedRun(status);
      assert.equal(await parentRunStillOpen(runId, userId), false);
    });
  }

  test("closed when the parent run is gone", async () => {
    const { userId } = await seedRun("running");
    assert.equal(
      await parentRunStillOpen(`run_${randomUUID().slice(0, 12)}`, userId),
      false,
      "a missing run answers closed, not open",
    );
  });

  test("closed when the run belongs to a different user", async () => {
    const { runId } = await seedRun("running");
    const { userId: otherUser } = await seedRun("running");
    assert.equal(
      await parentRunStillOpen(runId, otherUser),
      false,
      "getRun scopes by userId, so a foreign run is unreadable and reads as closed",
    );
  });
});
