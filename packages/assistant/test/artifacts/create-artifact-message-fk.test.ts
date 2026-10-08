import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { agentRuns, artifacts, chatMessages, chatThreads, user } from "@alfred/db/schemas";
import { eq, inArray, sql } from "drizzle-orm";

import { closeRedis } from "@alfred/db/redis";
import { createArtifact, finalizeRunArtifacts } from "@alfred/assistant/artifacts/write";
import { dbBackedSkip } from "../support/db-backed";

/**
 * `create_artifact` runs mid-turn, before the assistant message row exists.
 * So `message_id` stays NULL until the turn finalizes, or the insert fails
 * `artifacts_message_id_chat_messages_id_fk`.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-artifact-fk-";

const createdUserIds: string[] = [];

async function seedMidTurn(): Promise<{ userId: string; threadId: string; runId: string }> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  const threadId = randomUUID();
  await db().insert(chatThreads).values({ id: threadId, userId });
  const runId = `run_${randomUUID().slice(0, 12)}`;
  await db().insert(agentRuns).values({
    id: runId,
    userId,
    workflowSlug: "__test-artifact-fk",
    currentStep: "chat",
    status: "runnable",
    attempt: 0,
    state: {},
    lastCheckpointAt: new Date(),
  });

  // No chat_messages row: the mid-turn state.
  return { userId, threadId, runId };
}

describe("createArtifact message_id FK ordering", { skip: SKIP }, () => {
  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }

    await closeConnections();
    await closeRedis();
  });

  test("local schema enforces the production message_id foreign key", async () => {
    const result = await db().execute(sql`
      select count(*)::int as count
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      where t.relname = 'artifacts'
        and c.conname = 'artifacts_message_id_chat_messages_id_fk'
    `);

    const row = Array.isArray(result) ? result[0] : result.rows[0];
    assert.equal(Number((row as { count: number }).count), 1);
  });

  test("creates before the message exists, then associates it at turn finalization", async () => {
    const { userId, threadId, runId } = await seedMidTurn();

    const result = await createArtifact(
      { userId, threadId, runId },
      { title: "Resume — Yash Gourav Kar", kind: "pages", format: "pdf" },
    );

    if (!result.ok) {
      throw new Error(`expected create to succeed, got ${JSON.stringify(result)}`);
    }

    assert.equal(result.kind, "pages");
    assert.equal(result.format, "pdf");

    const [row] = await db()
      .select({
        messageId: artifacts.messageId,
        kind: artifacts.kind,
        format: artifacts.format,
        status: artifacts.status,
      })
      .from(artifacts)
      .where(eq(artifacts.id, result.artifactId));

    assert.ok(row, "artifact row persisted");
    assert.equal(row.messageId, null);
    assert.equal(row.kind, "pages");
    assert.equal(row.format, "pdf");
    assert.equal(row.status, "generating");

    const messageId = `msg_${randomUUID().slice(0, 12)}`;
    await db().insert(chatMessages).values({
      id: messageId,
      userId,
      threadId,
      runId,
      role: "assistant",
      status: "complete",
    });
    await finalizeRunArtifacts(userId, runId, messageId, "complete");

    const [finalized] = await db()
      .select({ messageId: artifacts.messageId, status: artifacts.status })
      .from(artifacts)
      .where(eq(artifacts.id, result.artifactId));

    assert.deepEqual(finalized, { messageId, status: "complete" });
  });

  test("does not finalize artifacts when the authoring message is still missing", async () => {
    const { userId, threadId, runId } = await seedMidTurn();

    const result = await createArtifact(
      { userId, threadId, runId },
      { title: "Still generating", kind: "document", markdown: "draft" },
    );

    assert.equal(result.ok, true);

    if (!result.ok) return;

    await finalizeRunArtifacts(userId, runId, `missing-${randomUUID()}`, "complete");

    const [row] = await db()
      .select({ messageId: artifacts.messageId, status: artifacts.status })
      .from(artifacts)
      .where(eq(artifacts.id, result.artifactId));

    assert.deepEqual(row, { messageId: null, status: "generating" });
  });
});
