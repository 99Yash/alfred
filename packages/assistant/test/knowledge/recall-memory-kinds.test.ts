import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { inArray, like } from "drizzle-orm";

import {
  recallMemory,
  USER_FACING_MEMORY_CHUNK_KINDS,
  writeMemoryChunk,
} from "@alfred/assistant/knowledge";
// Internal-by-intent: the embed backfill is not part of the `knowledge` barrel.
import { embedMemoryChunk } from "@alfred/assistant/knowledge/chunks";
import { dbBackedSkip } from "../support/db-backed";

/**
 * DB-backed test for the `recallMemory` kind restriction (#1052).
 *
 * The Context Search memory source passes `USER_FACING_MEMORY_CHUNK_KINDS`, so
 * the exclusion has to hold in the candidate query, before top-K: an
 * `extraction_run` chunk that is the *closest* vector must still be absent when
 * the set is applied, or a near telemetry chunk could displace a real memory
 * hit. The differential below proves exactly that — the same query returns the
 * telemetry chunk when `kinds` is omitted and drops it when the user-facing set
 * is passed, while the orthogonal `thread_summary` survives both times.
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable migrated
 * Postgres; skipped otherwise. Seeds throwaway `test-recallkinds-*` users and
 * cascades them away on teardown.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-recallkinds-";

const createdUserIds: string[] = [];

/** One-hot vector on `axis`, so cosine similarity to the query is exact. */
function unitVector(axis: number): number[] {
  const vector = Array.from({ length: 1024 }, () => 0);
  vector[axis] = 1;

  return vector;
}

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });

  return userId;
}

async function seedEmbeddedChunk(
  userId: string,
  kind: "thread_summary" | "extraction_run",
  content: string,
  embedding: number[],
): Promise<string> {
  const row = await writeMemoryChunk({ userId, kind, content, source: { kind: "agent" } });
  await embedMemoryChunk(row.id, userId, embedding);

  return row.id;
}

describe("recallMemory kind restriction (DB-backed)", { skip: SKIP }, () => {
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

  test("excludes a closest-by-distance extraction_run while returning a thread_summary", async () => {
    const userId = await seedUser();
    const query = "what does the user prefer";
    const queryEmbedding = unitVector(0);

    const runId = await seedEmbeddedChunk(
      userId,
      "extraction_run",
      "Memory-extraction run run_x: processed 20 document(s); proposed 0 fact(s).",
      unitVector(0),
    );

    const summaryId = await seedEmbeddedChunk(
      userId,
      "thread_summary",
      "The user prefers dark mode.",
      unitVector(1),
    );

    // Without a restriction the telemetry chunk is findable — and, being the
    // nearest vector, it is the top hit. This is the control: it proves the
    // chunk is a live candidate, so the next assertion is not vacuous.
    const unrestricted = await recallMemory({ userId, query, queryEmbedding, limit: 10 });
    assert.ok(
      unrestricted.some((hit) => hit.chunkId === runId),
      "control: the extraction_run must be findable when kinds is omitted",
    );

    const restricted = await recallMemory({
      userId,
      query,
      queryEmbedding,
      kinds: USER_FACING_MEMORY_CHUNK_KINDS,
      limit: 10,
    });

    assert.equal(
      restricted.some((hit) => hit.kind === "extraction_run"),
      false,
      "extraction_run must never survive the user-facing kind restriction",
    );
    assert.ok(
      restricted.some((hit) => hit.chunkId === summaryId),
      "the thread_summary must still be recalled",
    );
  });
});
