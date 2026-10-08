import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { agentRuns, agentSteps, user } from "@alfred/db/schemas";
import { and, eq, inArray, like } from "drizzle-orm";

import { leaseRun } from "@alfred/assistant/execution/executor";
import { dbBackedSkip } from "../support/db-backed";

/**
 * A step that never commits would be reclaimed forever (ADR-0070 §1.4). The 3rd
 * consecutive reclaim since the last progress fails the run; one worker death recovers.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-lease-";

const createdUserIds: string[] = [];

const STEP = "dispatch-tools";

// Older than STALE_RUN_LEASE_MS, so the row is reclaimable.
const STALE_CHECKPOINT = new Date(Date.now() - 5 * 60_000);

async function seedStaleRunningRun(attempt: number): Promise<{ userId: string; runId: string }> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  const runId = `run_${randomUUID().slice(0, 12)}`;
  await db().insert(agentRuns).values({
    id: runId,
    userId,
    workflowSlug: "chat",
    currentStep: STEP,
    status: "running",
    attempt,
    lastCheckpointAt: STALE_CHECKPOINT,
  });

  return { userId, runId };
}

async function insertRunningStep(runId: string, attempt: number) {
  await db().insert(agentSteps).values({ runId, stepId: STEP, attempt, status: "running" });
}

async function insertReclaimedStep(runId: string, attempt: number) {
  await db()
    .insert(agentSteps)
    .values({
      runId,
      stepId: STEP,
      attempt,
      status: "failed",
      error: {
        message: "lease reclaimed: previous worker presumed dead",
        reason: "lease_reclaimed",
      },
      endedAt: STALE_CHECKPOINT,
    });
}

async function runStatus(runId: string): Promise<string | undefined> {
  const rows = await db()
    .select({ status: agentRuns.status, error: agentRuns.error })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));

  return rows[0]?.status;
}

describe("lease backstop (DB-backed)", { skip: SKIP }, () => {
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

  test("a single worker death recovers (first reclaim is free)", async () => {
    const { runId } = await seedStaleRunningRun(5);
    await insertRunningStep(runId, 5);

    const leased = await leaseRun(runId);
    assert.equal(leased.kind, "leased", "stale-running with no prior reclaims must re-lease");
    assert.equal(
      leased.kind === "leased" ? leased.attempt : undefined,
      6,
      "reclaim bumps the attempt",
    );
    assert.equal(await runStatus(runId), "running", "the run stays runnable, not failed");

    const orphan = await db()
      .select({ status: agentSteps.status, error: agentSteps.error })
      .from(agentSteps)
      .where(and(eq(agentSteps.runId, runId), eq(agentSteps.attempt, 5)));

    assert.equal(orphan[0]?.status, "failed");
    assert.equal((orphan[0]?.error as { reason?: string })?.reason, "lease_reclaimed");
  });

  test("the 2nd reclaim still recovers (one prior reclaim, under the limit)", async () => {
    const { runId } = await seedStaleRunningRun(5);
    await insertReclaimedStep(runId, 4);
    await insertRunningStep(runId, 5);

    const leased = await leaseRun(runId);
    assert.equal(
      leased.kind,
      "leased",
      "with one prior reclaim, the second reclaim still recovers",
    );
    assert.equal(await runStatus(runId), "running");
  });

  test("the 3rd consecutive reclaim terminal-fails the run", async () => {
    const { runId } = await seedStaleRunningRun(5);
    await insertReclaimedStep(runId, 3);
    await insertReclaimedStep(runId, 4);
    await insertRunningStep(runId, 5);

    const leased = await leaseRun(runId);
    // `backstopped` lets the caller run workflow failure closure.
    assert.equal(leased.kind, "backstopped", "the backstop signals a terminal failure");
    assert.match(
      leased.kind === "backstopped" ? leased.error : "",
      /not progressing/,
      "the backstop hands back the synthetic clean message",
    );
    assert.equal(await runStatus(runId), "failed", "the run is now terminal");

    const rows = await db()
      .select({ error: agentRuns.error })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));

    const message = (rows[0]?.error as { message?: string })?.message ?? "";
    assert.match(message, /not progressing/, "the terminal message is the synthetic clean string");
  });

  test("a HIL interrupt since the prior reclaims resets the count (forward progress)", async () => {
    // An `interrupted` step is forward progress, so only reclaims after it count.
    const { runId } = await seedStaleRunningRun(6);
    await insertReclaimedStep(runId, 3);
    await insertReclaimedStep(runId, 4);
    await db().insert(agentSteps).values({
      runId,
      stepId: STEP,
      attempt: 5,
      status: "interrupted",
      endedAt: STALE_CHECKPOINT,
    });
    await insertRunningStep(runId, 6);

    const leased = await leaseRun(runId);
    assert.equal(
      leased.kind,
      "leased",
      "an interrupt resets the reclaim count just like a completed step",
    );
    assert.equal(await runStatus(runId), "running");
  });

  test("a readiness deferral since prior reclaims resets the count", async () => {
    const { runId } = await seedStaleRunningRun(6);
    await insertReclaimedStep(runId, 3);
    await insertReclaimedStep(runId, 4);
    await db().insert(agentSteps).values({
      runId,
      stepId: STEP,
      attempt: 5,
      status: "deferred",
      endedAt: STALE_CHECKPOINT,
    });
    await insertRunningStep(runId, 6);

    const leased = await leaseRun(runId);
    assert.equal(leased.kind, "leased", "a committed defer resets the reclaim tail");
    assert.equal(await runStatus(runId), "running");
  });

  test("a successful step since the prior reclaims resets the count", async () => {
    // Two reclaim rows in history, but only the one after the completed attempt 4 counts.
    const { runId } = await seedStaleRunningRun(7);
    await insertReclaimedStep(runId, 3);
    await db()
      .insert(agentSteps)
      .values({ runId, stepId: STEP, attempt: 4, status: "completed", endedAt: STALE_CHECKPOINT });
    await insertReclaimedStep(runId, 6);
    await insertRunningStep(runId, 7);

    const leased = await leaseRun(runId);
    assert.equal(
      leased.kind,
      "leased",
      "reclaims before the last successful step don't count toward the limit",
    );
    assert.equal(await runStatus(runId), "running");
  });
});
