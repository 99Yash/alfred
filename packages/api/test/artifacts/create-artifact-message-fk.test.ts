import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { agentRuns, artifacts, chatMessages, chatThreads, user } from "@alfred/db/schemas";
import { databaseEnv } from "@alfred/env/database";
import { eq, inArray, sql } from "drizzle-orm";

import { closeRedis } from "../../src/queue/connection";
import { createArtifact, finalizeRunArtifacts } from "../../src/modules/artifacts/write";

/**
 * DB-backed regression for the `artifacts.message_id` FK-ordering bug.
 *
 * The authoring assistant message is not persisted to `chat_messages` until the
 * turn finalizes (observed ~2 min after the run starts), but `create_artifact`
 * runs mid-turn. Writing `message_id = <that not-yet-persisted id>` failed
 * `artifacts_message_id_chat_messages_id_fk` for the whole turn, so artifact
 * creation failed 100% of the time in prod (all retries failed identically) and
 * the raw failed query — including `user_id` — leaked into the chat. The fix
 * leaves `message_id` NULL (the column is read nowhere; a dormant v1 seam).
 *
 * This seeds the exact mid-turn state — user + thread + run exist, but NO
 * `chat_messages` row — and asserts the insert now succeeds with `message_id`
 * NULL. Before the fix this threw the FK violation.
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable migrated Postgres.
 */
const SKIP = (() => {
  try {
    databaseEnv();
    return false;
  } catch {
    return "DATABASE_URL not set — skipping DB-backed test";
  }
})();

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
  // Deliberately DO NOT insert a chat_messages row: this is the mid-turn state
  // where the authoring assistant message does not exist yet.
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
});
