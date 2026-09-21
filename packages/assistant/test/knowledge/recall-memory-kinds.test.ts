import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { inArray, like } from "drizzle-orm";

import {
  MEMORY_CHUNK_KINDS,
  recallMemory,
  USER_FACING_MEMORY_CHUNK_KINDS,
  writeMemoryChunk,
} from "@alfred/assistant/knowledge";
// Internal-by-intent: the embed backfill is not part of the `knowledge` barrel.
import { embedMemoryChunk } from "@alfred/assistant/knowledge/chunks";
import { dbBackedSkip } from "../support/db-backed";

/**
 * DB-backed test for `recallMemory`'s kind handling (#1052).
 *
 * The primitive defaults `kinds` to `USER_FACING_MEMORY_CHUNK_KINDS`, and the
 * restriction is applied in the candidate query before the HNSW pool and
 * top-K. Two properties need proof the offline type system cannot give:
 *
 *  - The exclusion must not be a fetch-then-drop. The seed plants
 *    `EXCLUDED_SEED_COUNT` operational chunks nearer the query than the one
 *    real memory chunk, so the excluded kind alone fills more than the
 *    candidate pool (`max(limit * 5, 50)`). A post-pool drop would return
 *    nothing; only a candidate-query filter returns the summary. The same seed
 *    makes the default's safety observable — with no `kinds` the summary must
 *    still come back and no telemetry may.
 *  - An empty set is an explicit "no kinds", not "any".
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable migrated
 * Postgres; skipped otherwise. Seeds throwaway `test-recallkinds-*` users and
 * cascades them away on teardown.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-recallkinds-";

const LIMIT = 10;

// `recallMemory` pulls `max(limit * 5, 50)` candidates before reranking.
const CANDIDATE_POOL = Math.max(LIMIT * 5, 50);

// One more than the pool: the excluded kind alone cannot fit inside it, so a
// fetch-then-drop implementation would starve the real memory chunk.
const EXCLUDED_SEED_COUNT = CANDIDATE_POOL + 1;

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

  test("defaults to user-facing kinds and filters before the candidate pool", async () => {
    const userId = await seedUser();
    const query = "what does the user prefer";
    const queryEmbedding = unitVector(0);

    const summaryId = await seedEmbeddedChunk(
      userId,
      "thread_summary",
      "The user prefers dark mode.",
      unitVector(1),
    );

    // Every operational chunk is nearer the query than the summary.
    for (let i = 0; i < EXCLUDED_SEED_COUNT; i += 1) {
      await seedEmbeddedChunk(
        userId,
        "extraction_run",
        `Memory-extraction run run_${i}: processed ${i} document(s); proposed 0 fact(s).`,
        unitVector(0),
      );
    }

    // Control: with every kind allowed the telemetry chunks are live
    // candidates, so the exclusions below are not vacuous.
    const allKinds = await recallMemory({
      userId,
      query,
      queryEmbedding,
      kinds: MEMORY_CHUNK_KINDS,
      limit: LIMIT,
    });

    assert.ok(
      allKinds.some((hit) => hit.kind === "extraction_run"),
      "control: the extraction_run chunks must be findable when every kind is allowed",
    );

    // Default (no `kinds`): user-facing only. If the filter were applied after
    // the candidate pool, the excluded chunks would fill the pool and the
    // summary could not come back.
    const defaulted = await recallMemory({ userId, query, queryEmbedding, limit: LIMIT });
    assert.equal(
      defaulted.some((hit) => hit.kind === "extraction_run"),
      false,
      "an extraction_run must never survive the default user-facing restriction",
    );
    assert.ok(
      defaulted.some((hit) => hit.chunkId === summaryId),
      "the thread_summary must still be recalled through the candidate-query filter",
    );

    // The explicit user-facing set is the same restriction as the default.
    const explicit = await recallMemory({
      userId,
      query,
      queryEmbedding,
      kinds: USER_FACING_MEMORY_CHUNK_KINDS,
      limit: LIMIT,
    });

    assert.equal(
      explicit.some((hit) => hit.kind === "extraction_run"),
      false,
    );
    assert.ok(explicit.some((hit) => hit.chunkId === summaryId));

    // An empty set means "no kinds", not "any".
    const none = await recallMemory({ userId, query, queryEmbedding, kinds: [], limit: LIMIT });
    assert.deepEqual(none, []);
  });
});
