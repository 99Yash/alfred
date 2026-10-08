import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { HttpError } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { documents, memoryChunks, user } from "@alfred/db/schemas";
import { recordDocumentEmbedFailure, findUnembeddedDocumentIds } from "@alfred/corpus";
import { eq, inArray, like } from "drizzle-orm";

// Internal helpers, not in the `knowledge` barrel.
import {
  findPendingEmbedChunks,
  pendingEmbedChunkIds,
  recordMemoryEmbedFailure,
} from "@alfred/assistant/knowledge/chunks";
import { dbBackedSkip } from "../support/db-backed";

/**
 * Embed poison-pill guard on `memory_chunks` and `documents`. Needs a migrated `DATABASE_URL`.
 * A per-input error (400/413/422) dead-letters at once. A systemic error (401/403/404),
 * a 429, or a 5xx retries until the first failure passes `EMBED_RETRY_WINDOW_HOURS`,
 * so a key rotation or outage does not drop the backlog. The first-failure stamp is set once.
 * Not covered: the real `embed()` catch path, which needs provider mocks.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-embedpoison-";

// Many attempts, to prove the attempt count does not dead-letter.
const TRANSIENT_FAILURES_IN_WINDOW = 8;

const createdUserIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });

  return userId;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Insert an un-embedded memory chunk (embedding NULL) and return its id. */
async function seedUnembeddedChunk(userId: string): Promise<string> {
  const content = `poison-${randomUUID()}`;

  const [row] = await db()
    .insert(memoryChunks)
    .values({ userId, kind: "thread_summary", content, contentHash: sha256(content) })
    .returning({ id: memoryChunks.id });

  assert.ok(row, "seed insert returned no row");

  return row.id;
}

/** Insert an un-embedded document (no chunks rows) and return its id. */
async function seedUnembeddedDocument(userId: string): Promise<string> {
  const content = `poison-doc-${randomUUID()}`;

  const [row] = await db()
    .insert(documents)
    .values({
      userId,
      source: "gmail",
      sourceId: randomUUID(),
      content,
      contentHash: sha256(content),
    })
    .returning({ id: documents.id });

  assert.ok(row, "seed insert returned no row");

  return row.id;
}

async function readChunk(
  chunkId: string,
): Promise<{ embedAttempts: number; failed: boolean; firstFailedAt: Date | null }> {
  const [row] = await db()
    .select({
      embedAttempts: memoryChunks.embedAttempts,
      embedFailedAt: memoryChunks.embedFailedAt,
      embedFirstFailedAt: memoryChunks.embedFirstFailedAt,
    })
    .from(memoryChunks)
    .where(eq(memoryChunks.id, chunkId));

  assert.ok(row, "chunk row disappeared");

  return {
    embedAttempts: row.embedAttempts,
    failed: row.embedFailedAt != null,
    firstFailedAt: row.embedFirstFailedAt,
  };
}

async function readDocument(docId: string): Promise<{ embedAttempts: number; failed: boolean }> {
  const [row] = await db()
    .select({ embedAttempts: documents.embedAttempts, embedFailedAt: documents.embedFailedAt })
    .from(documents)
    .where(eq(documents.id, docId));

  assert.ok(row, "document row disappeared");

  return { embedAttempts: row.embedAttempts, failed: row.embedFailedAt != null };
}

/** Backdate the first-failure marker so the transient window is provably elapsed. */
async function backdateChunkFirstFailure(chunkId: string, hoursAgo: number): Promise<void> {
  await db()
    .update(memoryChunks)
    .set({ embedFirstFailedAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000) })
    .where(eq(memoryChunks.id, chunkId));
}

async function backdateDocumentFirstFailure(docId: string, hoursAgo: number): Promise<void> {
  await db()
    .update(documents)
    .set({ embedFirstFailedAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000) })
    .where(eq(documents.id, docId));
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

  test("a fresh un-embedded chunk is a sweep candidate (per-user and global)", async () => {
    const userId = await seedUser();
    const chunkId = await seedUnembeddedChunk(userId);
    const perUser = await pendingEmbedChunkIds(userId);
    assert.ok(perUser.includes(chunkId), "fresh chunk should be pending (per-user)");
    // The worker sweeps the global finder, not the per-user one.
    const global = await findPendingEmbedChunks(5000);
    assert.ok(
      global.some((r) => r.id === chunkId),
      "fresh chunk should be pending (global finder)",
    );
  });

  test("a permanent (400) error dead-letters a chunk on the first failure", async () => {
    const userId = await seedUser();
    const chunkId = await seedUnembeddedChunk(userId);

    await recordMemoryEmbedFailure(chunkId, userId, httpError(400));

    const state = await readChunk(chunkId);
    assert.equal(state.embedAttempts, 1, "one attempt recorded");
    assert.equal(state.failed, true, "400 should dead-letter immediately");
    const perUser = await pendingEmbedChunkIds(userId);
    assert.ok(!perUser.includes(chunkId), "dead-lettered chunk must drop out (per-user)");
    const global = await findPendingEmbedChunks(5000);
    assert.ok(
      !global.some((r) => r.id === chunkId),
      "dead-lettered chunk must drop out (global finder)",
    );
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

  test("systemic (401/403/404) errors do NOT dead-letter on the first failure", async () => {
    // 401/403/404 hit every row until the key or quota is fixed. As permanent, they
    // would dead-letter the whole backlog on the first sweep.
    for (const status of [401, 403, 404]) {
      const userId = await seedUser();
      const chunkId = await seedUnembeddedChunk(userId);

      await recordMemoryEmbedFailure(chunkId, userId, httpError(status));

      const state = await readChunk(chunkId);
      assert.equal(state.failed, false, `${status} is systemic — must not dead-letter early`);
      const pending = await pendingEmbedChunkIds(userId);
      assert.ok(pending.includes(chunkId), `${status} chunk should remain a candidate`);
    }
  });

  test("P1: a burst of transient (500) failures does NOT dead-letter within the window", async () => {
    const userId = await seedUser();
    const chunkId = await seedUnembeddedChunk(userId);

    // An outage: many quick failed sweeps. The first failure stays recent, so nothing dies.
    for (let i = 1; i <= TRANSIENT_FAILURES_IN_WINDOW; i++) {
      await recordMemoryEmbedFailure(chunkId, userId, httpError(500));
      const mid = await readChunk(chunkId);
      assert.equal(mid.embedAttempts, i, `attempt ${i} counted`);
      assert.equal(
        mid.failed,
        false,
        `outage must not dead-letter within the window (attempt ${i})`,
      );
    }

    const pending = await pendingEmbedChunkIds(userId);
    assert.ok(pending.includes(chunkId), "backlog survives a transient outage");

    // Once the failure has persisted past the window, the next sweep gives up.
    await backdateChunkFirstFailure(chunkId, 25);
    await recordMemoryEmbedFailure(chunkId, userId, httpError(500));
    const final = await readChunk(chunkId);
    assert.equal(final.failed, true, "dead-lettered once first failure is older than the window");
    const after = await pendingEmbedChunkIds(userId);
    assert.ok(!after.includes(chunkId), "capped chunk must drop out of the candidate set");
  });

  test("P1: embed_first_failed_at is stamped ONCE across repeated failures", async () => {
    // A re-stamp would keep the window fresh forever. Check the column, because
    // outcome tests stay failed=false either way.
    const userId = await seedUser();
    const chunkId = await seedUnembeddedChunk(userId);

    await recordMemoryEmbedFailure(chunkId, userId, httpError(500));
    const first = await readChunk(chunkId);
    assert.ok(first.firstFailedAt, "the first failure must stamp embed_first_failed_at");
    const stampedAt = first.firstFailedAt;

    for (let i = 2; i <= TRANSIENT_FAILURES_IN_WINDOW; i++) {
      await recordMemoryEmbedFailure(chunkId, userId, httpError(500));
      const state = await readChunk(chunkId);
      assert.deepEqual(
        state.firstFailedAt,
        stampedAt,
        `embed_first_failed_at must not re-stamp (failure ${i})`,
      );
    }
  });

  test("a fresh un-embedded document is a sweep candidate", async () => {
    const userId = await seedUser();
    const docId = await seedUnembeddedDocument(userId);
    const pending = await findUnembeddedDocumentIds({ userId, limit: 5000 });
    assert.ok(pending.includes(docId), "fresh document should be pending");
  });

  test("a permanent (400) error dead-letters a document on the first failure", async () => {
    const userId = await seedUser();
    const docId = await seedUnembeddedDocument(userId);

    await recordDocumentEmbedFailure(docId, httpError(400));

    const state = await readDocument(docId);
    assert.equal(state.embedAttempts, 1, "one attempt recorded");
    assert.equal(state.failed, true, "400 should dead-letter immediately");
    const pending = await findUnembeddedDocumentIds({ userId, limit: 5000 });
    assert.ok(
      !pending.includes(docId),
      "dead-lettered document must drop out of the candidate set",
    );
  });

  test("P1: a burst of transient (500) failures does NOT dead-letter a document within the window", async () => {
    const userId = await seedUser();
    const docId = await seedUnembeddedDocument(userId);

    for (let i = 1; i <= TRANSIENT_FAILURES_IN_WINDOW; i++) {
      await recordDocumentEmbedFailure(docId, httpError(500));
      const mid = await readDocument(docId);
      assert.equal(mid.embedAttempts, i, `attempt ${i} counted`);
      assert.equal(
        mid.failed,
        false,
        `outage must not dead-letter within the window (attempt ${i})`,
      );
    }

    const pending = await findUnembeddedDocumentIds({ userId, limit: 5000 });
    assert.ok(pending.includes(docId), "backlog survives a transient outage");

    await backdateDocumentFirstFailure(docId, 25);
    await recordDocumentEmbedFailure(docId, httpError(500));
    const final = await readDocument(docId);
    assert.equal(final.failed, true, "dead-lettered once first failure is older than the window");
    const after = await findUnembeddedDocumentIds({ userId, limit: 5000 });
    assert.ok(!after.includes(docId), "capped document must drop out of the candidate set");
  });
});
