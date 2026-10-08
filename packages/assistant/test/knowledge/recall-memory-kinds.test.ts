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
// Internal helper, not in the `knowledge` barrel.
import { embedMemoryChunk } from "@alfred/assistant/knowledge/chunks";
import { dbBackedSkip } from "../support/db-backed";

/**
 * `recallMemory` kind filter. Needs a migrated `DATABASE_URL`.
 * The kind filter must run in the candidate query, not after the pool fills.
 * An empty `kinds` means no kinds, not any.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-recallkinds-";

const LIMIT = 10;

// `recallMemory` pulls `max(limit * 5, 50)` candidates before reranking.
const CANDIDATE_POOL = Math.max(LIMIT * 5, 50);

// Excluded chunks overfill the pool, so filtering after the fetch returns nothing.
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

    // Control: with every kind allowed, the telemetry chunks do come back.
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

    // Default (no `kinds`) is user-facing only.
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
