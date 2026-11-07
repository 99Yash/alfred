import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { agentRuns, artifacts, chatThreads, user } from "@alfred/db/schemas";
import { eq, inArray } from "drizzle-orm";

import { closeRedis } from "@alfred/db/redis";
import { artifactContentHash } from "@alfred/assistant/artifacts/content-hash";
import { createArtifact, updateArtifact } from "@alfred/assistant/artifacts/write";
import { dbBackedSkip } from "../support/db-backed";

/**
 * SM-07: a faulted turn leaves its artifact in `error`. A later turn that replaces the
 * whole body must move it to `complete`, because `finalizeRunArtifacts` closes only the
 * creating run's rows and never reaches this one again.
 */

const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-artifact-repair-";

const createdUserIds: string[] = [];

async function insertRun(userId: string): Promise<string> {
  const runId = `run_${randomUUID().slice(0, 12)}`;
  await db().insert(agentRuns).values({
    id: runId,
    userId,
    workflowSlug: "__test-artifact-repair",
    currentStep: "chat",
    status: "runnable",
    attempt: 0,
    state: {},
    lastCheckpointAt: new Date(),
  });

  return runId;
}

/** Turn 1 creates a document and faults; returns both turns' contexts. */
async function seedFaultedArtifact(): Promise<{
  artifactId: string;
  turn2: { userId: string; threadId: string; runId: string };
}> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  const threadId = randomUUID();
  await db().insert(chatThreads).values({ id: threadId, userId });

  const turn1 = { userId, threadId, runId: await insertRun(userId) };

  const created = await createArtifact(turn1, {
    title: "Report",
    kind: "document",
    markdown: "Partial body",
  });

  await db().update(artifacts).set({ status: "error" }).where(eq(artifacts.id, created.artifactId));

  return {
    artifactId: created.artifactId,
    turn2: { userId, threadId, runId: await insertRun(userId) },
  };
}

async function readStatus(artifactId: string): Promise<string | undefined> {
  const [row] = await db()
    .select({ status: artifacts.status })
    .from(artifacts)
    .where(eq(artifacts.id, artifactId));

  return row?.status;
}

describe("updateArtifact on a faulted artifact", { skip: SKIP }, () => {
  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }

    await closeConnections();
    await closeRedis();
  });

  test("a later turn's full replacement moves it from error to complete", async () => {
    const { artifactId, turn2 } = await seedFaultedArtifact();

    const result = await updateArtifact(turn2, {
      artifactId,
      markdown: "Finished body",
      baseContentHash: artifactContentHash({ kind: "document", markdown: "Partial body" }),
    });

    assert.equal(result.ok, true);
    assert.equal(await readStatus(artifactId), "complete");
  });

  test("a later turn's rename alone leaves it in error", async () => {
    const { artifactId, turn2 } = await seedFaultedArtifact();

    const result = await updateArtifact(turn2, { artifactId, title: "Renamed" });

    assert.equal(result.ok, true);
    assert.equal(await readStatus(artifactId), "error");
  });
});
