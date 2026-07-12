import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { HttpError } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { memoryChunks, user } from "@alfred/db/schemas";
import { eq, inArray, like } from "drizzle-orm";

import { pendingEmbedChunkIds, recordMemoryEmbedFailure } from "../../src/modules/memory/chunks";

/**
 * DB-backed test for the embedding poison-pill guard on `memory_chunks`
 * (mirrors the `documents` guard). Proves the retry storm can terminate:
 *   1. a permanent provider error (a 4xx that isn't 429) dead-letters the chunk
 *      on the FIRST failure, so it drops out of the embed-sweep candidate set;
 *   2. a transient error (5xx) is tolerated up to the attempt cap, then
 *      dead-lettered — never re-selected forever.
 *
 * `MAX_EMBED_ATTEMPTS` is 5 in the implementation; asserted structurally
 * (still-pending before the cap, dead-lettered at it) rather than by importing
 * the private constant.
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable migrated
 * Postgres; skipped otherwise. Seeds throwaway `test-embedpoison-*` users and
 * cascades them away on teardown.
 */
const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

const ID_PREFIX = "test-embedpoison-";
const MAX_EMBED_ATTEMPTS = 5;
const createdUserIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  return userId;
}

/** Insert an un-embedded memory chunk (embedding NULL) and return its id. */
async function seedUnembeddedChunk(userId: string): Promise<string> {
  const content = `poison-${randomUUID()}`;
  const [row] = await db()
    .insert(memoryChunks)
    .values({
      userId,
      kind: "thread_summary",
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
    })
    .returning({ id: memoryChunks.id });
  assert.ok(row, "seed insert returned no row");
  return row.id;
}

async function readChunk(chunkId: string): Promise<{ embedAttempts: number; failed: boolean }> {
  const [row] = await db()
    .select({ embedAttempts: memoryChunks.embedAttempts, embedFailedAt: memoryChunks.embedFailedAt })
    .from(memoryChunks)
    .where(eq(memoryChunks.id, chunkId));
  assert.ok(row, "chunk row disappeared");
  return { embedAttempts: row.embedAttempts, failed: row.embedFailedAt != null };
}

function httpError(status: number): HttpError {
  return new HttpError({ provider: "embeddings", status, url: "voyage/embeddings", body: "err" });
}

describe("memory embed poison-pill guard (DB-backed)", { skip: SKIP }, () => {
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

  test("a fresh un-embedded chunk is a sweep candidate", async () => {
    const userId = await seedUser();
    const chunkId = await seedUnembeddedChunk(userId);
    const pending = await pendingEmbedChunkIds(userId);
    assert.ok(pending.includes(chunkId), "fresh chunk should be pending");
  });

  test("a permanent (400) error dead-letters on the first failure", async () => {
    const userId = await seedUser();
    const chunkId = await seedUnembeddedChunk(userId);

    await recordMemoryEmbedFailure(chunkId, userId, httpError(400));

    const state = await readChunk(chunkId);
    assert.equal(state.embedAttempts, 1, "one attempt recorded");
    assert.equal(state.failed, true, "400 should dead-letter immediately");
    const pending = await pendingEmbedChunkIds(userId);
    assert.ok(!pending.includes(chunkId), "dead-lettered chunk must drop out of the candidate set");
  });

  test("a 429 is treated as transient, not permanent", async () => {
    const userId = await seedUser();
    const chunkId = await seedUnembeddedChunk(userId);

    await recordMemoryEmbedFailure(chunkId, userId, httpError(429));

    const state = await readChunk(chunkId);
    assert.equal(state.failed, false, "429 (rate-limit) is retryable — must not dead-letter early");
    const pending = await pendingEmbedChunkIds(userId);
    assert.ok(pending.includes(chunkId), "rate-limited chunk should remain a candidate");
  });

  test("transient (500) failures dead-letter only once the attempt cap is reached", async () => {
    const userId = await seedUser();
    const chunkId = await seedUnembeddedChunk(userId);

    for (let i = 1; i < MAX_EMBED_ATTEMPTS; i++) {
      await recordMemoryEmbedFailure(chunkId, userId, httpError(500));
      const mid = await readChunk(chunkId);
      assert.equal(mid.embedAttempts, i, `attempt ${i} counted`);
      assert.equal(mid.failed, false, `still retrying before the cap (attempt ${i})`);
    }

    // The cap-th failure crosses the threshold.
    await recordMemoryEmbedFailure(chunkId, userId, httpError(500));
    const final = await readChunk(chunkId);
    assert.equal(final.embedAttempts, MAX_EMBED_ATTEMPTS, "cap reached");
    assert.equal(final.failed, true, "dead-lettered at the attempt cap");
    const pending = await pendingEmbedChunkIds(userId);
    assert.ok(!pending.includes(chunkId), "capped chunk must drop out of the candidate set");
  });
});
