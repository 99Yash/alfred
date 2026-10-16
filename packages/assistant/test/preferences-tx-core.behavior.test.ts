import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { inArray, like } from "drizzle-orm";

import { settings } from "../src/settings";
import { dbBackedSkip } from "./support/db-backed";

/**
 * `settings({ userId, exec: tx })` writes on a caller's transaction.
 * The Replicache `prefSet`/`prefDelete` mutators bind this way, so writes must commit and roll back with the push.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-settings-tx-";

const createdUserIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });

  return userId;
}

describe("settings preference tx cores (DB-backed)", { skip: SKIP }, () => {
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

  test("set on a committed tx writes the row and bumps rowVersion", async () => {
    const userId = await seedUser();

    await db().transaction(async (tx) => {
      await settings({ userId, exec: tx }).set("tone", "concise");
    });
    const first = await settings({ userId }).get("tone");
    assert.equal(first?.value, "concise", "the committed tx write is readable");
    assert.equal(first?.rowVersion, 0, "first write starts at rowVersion 0");

    await db().transaction(async (tx) => {
      await settings({ userId, exec: tx }).set("tone", "verbose");
    });
    const second = await settings({ userId }).get("tone");
    assert.equal(second?.value, "verbose", "last write wins");
    assert.equal(second?.rowVersion, 1, "a second tx upsert bumps rowVersion");
  });

  test("a throw after a tx-bound set rolls the write back — no row survives", async () => {
    const userId = await seedUser();

    await assert.rejects(
      db().transaction(async (tx) => {
        await settings({ userId, exec: tx }).set("tone", "concise");
        throw new Error("boom");
      }),
      /boom/,
    );

    assert.equal(
      await settings({ userId }).get("tone"),
      null,
      "the aborted tx leaves no preference row",
    );
  });

  test("a tx-bound delete inside a rolled-back tx leaves the row present", async () => {
    const userId = await seedUser();
    await settings({ userId }).set("tone", "concise");

    await assert.rejects(
      db().transaction(async (tx) => {
        await settings({ userId, exec: tx }).delete("tone");
        throw new Error("boom");
      }),
      /boom/,
    );

    const read = await settings({ userId }).get("tone");
    assert.equal(read?.value, "concise", "the aborted delete leaves the row intact");
  });
});
