import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { HttpError } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { documents, memoryChunks, user } from "@alfred/db/schemas";
import { recordDocumentEmbedFailure, findUnembeddedDocumentIds } from "@alfred/ingestion";
import { eq, inArray, like } from "drizzle-orm";

import {
  findPendingEmbedChunks,
  pendingEmbedChunkIds,
  recordMemoryEmbedFailure,
} from "../../src/modules/memory/chunks";

/**
 * DB-backed test for the embedding poison-pill guard on both `memory_chunks`
 * and `documents`. It proves the retry storm terminates WITHOUT destroying the
 * backlog during a provider outage:
 *
 *   1. a per-input-permanent error (400/413/422 — the input itself is
 *      un-embeddable) dead-letters the row on the FIRST failure, so it drops out
 *      of the embed-sweep candidate set;
 *   2. a systemic error (401/403/404 — rotated key, quota trip, endpoint change)
 *      is NOT per-input, so it must NOT dead-letter on the first failure; it
 *      rides the wall-clock window like any transient failure. Regression guard
 *      for the blocker: classifying these as permanent would dead-letter the
 *      whole pending backlog on the first sweep of a key-rotation lag;
 *   3. a 429 (rate-limit) is transient, not permanent;
 *   4. a transient error (5xx) is retried for a wall-clock window regardless of
 *      how many sweeps hit it — the P1 regression guard: a 25-minute outage
 *      that burns >MAX attempts must NOT dead-letter — and only dead-letters
 *      once the *first* failure is older than `EMBED_RETRY_WINDOW_HOURS`;
 *   5. the first-failure marker is stamped ONCE (COALESCE) — re-stamping every
 *      sweep would perpetually reset the window and reintroduce the retry storm.
 *
 * The wall-clock window is 24h in the implementation; the tests backdate
 * `embed_first_failed_at` rather than sleeping, and assert structurally (never
 * import the private constant) so a window change doesn't break them.
 *
 * Gap (documented, not covered): none of these drive the real `embed()`/
 * `embedMany()` → catch → record path; forcing a deterministic Voyage failure
 * needs provider mocking. They exercise the record/select layer directly, which
 * is where the guard's SQL lives.
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable migrated
 * Postgres; skipped otherwise. Seeds throwaway `test-embedpoison-*` users and
 * cascades them away on teardown.
 */
const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

const ID_PREFIX = "test-embedpoison-";
// More than the old attempt cap (5), to prove attempt count no longer gates.
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
    // The worker sweeps the global finder, not the per-user one — cover it too.
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
    // Rotated key (401), quota/billing/permission trip (403), endpoint change
    // (404): each returns the same status for every row while it lasts, then
    // clears. The blocker regression guard — treating these as permanent would
    // dead-letter the entire pending backlog on the first sweep of a routine
    // key-rotation lag. They must ride the wall-clock window instead.
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

    // Simulate an outage: many sweeps fail in quick succession, past the old
    // attempt cap. The first-failure marker stays recent, so nothing dies.
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
    // The mechanism the whole wall-clock window rests on: the guard writes
    // COALESCE(firstFailedAt, now()), so the ORIGINAL first-failure time must
    // survive every subsequent sweep. Re-stamping it each failure would keep the
    // window perpetually fresh — the infinite retry storm the guard terminates.
    // Assert the column directly: the outcome-level tests can't catch a re-stamp
    // because a fresh burst stays failed=false either way.
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
