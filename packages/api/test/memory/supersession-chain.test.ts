import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { user, userFacts } from "@alfred/db/schemas";
import { inArray, like } from "drizzle-orm";

import { getSupersessionChain } from "../../src/modules/memory/facts";

/**
 * DB-backed test for `getSupersessionChain`'s recursive-CTE traversal (#189):
 *   1. a multi-hop chain comes back tip-first (the starting row, then each
 *      predecessor it supersedes back to the origin root), in one query
 *      regardless of length;
 *   2. a cyclic `supersedes_id` pointer terminates via the depth bound instead
 *      of looping forever.
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable migrated
 * Postgres; skipped otherwise so the pure-function suite still runs without a
 * database. Seeds throwaway `test-superchain-*` users and cascades them away on
 * teardown.
 */
const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

const ID_PREFIX = "test-superchain-";
const createdUserIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  return userId;
}

/** Insert a fact with a fixed id and optional predecessor link. */
async function seedFact(userId: string, id: string, supersedesId: string | null): Promise<void> {
  await db()
    .insert(userFacts)
    .values({
      id,
      userId,
      key: "manager",
      value: id,
      confidence: 1,
      source: { kind: "user" },
      supersedesId,
    });
}

describe("getSupersessionChain (DB-backed)", { skip: SKIP }, () => {
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

  test("walks a multi-hop chain tip-first in id order", async () => {
    const userId = await seedUser();
    // C supersedes B supersedes A.
    const a = `fact_${randomUUID().slice(0, 8)}`;
    const b = `fact_${randomUUID().slice(0, 8)}`;
    const c = `fact_${randomUUID().slice(0, 8)}`;
    await seedFact(userId, a, null);
    await seedFact(userId, b, a);
    await seedFact(userId, c, b);

    const chain = await getSupersessionChain(userId, c);
    assert.deepEqual(
      chain.map((f) => f.id),
      [c, b, a],
      "chain should start at the queried row and follow supersedes_id back to origin",
    );
  });

  test("does not cross a user boundary", async () => {
    const owner = await seedUser();
    const intruder = await seedUser();
    const root = `fact_${randomUUID().slice(0, 8)}`;
    const tip = `fact_${randomUUID().slice(0, 8)}`;
    await seedFact(owner, root, null);
    // `tip` belongs to the intruder but points at the owner's row — the
    // user-scoped join must not pull `root` into the intruder's chain.
    await seedFact(intruder, tip, root);

    const chain = await getSupersessionChain(intruder, tip);
    assert.deepEqual(
      chain.map((f) => f.id),
      [tip],
      "chain must stay within the querying user",
    );
  });

  test("terminates on a cyclic supersedes_id pointer", async () => {
    const userId = await seedUser();
    const x = `fact_${randomUUID().slice(0, 8)}`;
    const y = `fact_${randomUUID().slice(0, 8)}`;
    // Insert with no link, then close the cycle: X -> Y -> X.
    await seedFact(userId, x, null);
    await seedFact(userId, y, x);
    await db()
      .update(userFacts)
      .set({ supersedesId: y })
      .where(inArray(userFacts.id, [x]));

    // Should return bounded output without hanging.
    const chain = await getSupersessionChain(userId, x);
    assert.ok(chain.length > 0, "cyclic chain should still return rows");
    assert.ok(chain.length <= 257, "cyclic chain must be bounded by the depth guard");
  });
});
