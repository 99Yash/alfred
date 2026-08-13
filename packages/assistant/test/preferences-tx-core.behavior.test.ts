import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { inArray, like } from "drizzle-orm";

import {
  deletePreferenceRow,
  getPreference,
  setPreference,
  upsertPreference,
} from "../src/settings";
import { dbBackedSkip } from "./support/db-backed";

/**
 * DB-backed integration test for the `tx`-accepting preference cores —
 * `upsertPreference` / `deletePreferenceRow` executed against a Drizzle
 * transaction rather than the pooled `db()` handle. This is the seam this
 * campaign item introduces: the Replicache `prefSet` / `prefDelete` mutators
 * route through these cores against the push transaction, so the write must
 * commit and roll back with that outer transaction. The gateway paths
 * (`setPreference` / `deletePreference` via `db()`) are covered by
 * `preferences.behavior.test.ts` and are unchanged.
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable Postgres with the
 * migrated schema. Skipped otherwise. Seeds throwaway `test-settings-tx-*`
 * users and deletes them (cascade clears their preferences) on teardown.
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

  test("upsertPreference against a committed tx writes the row and bumps rowVersion", async () => {
    const userId = await seedUser();

    await db().transaction(async (tx) => {
      await upsertPreference(tx, { userId, key: "tone", value: "concise" });
    });
    const first = await getPreference(userId, "tone");
    assert.equal(first?.value, "concise", "the committed tx write is readable");
    assert.equal(first?.rowVersion, 0, "first write starts at rowVersion 0");

    await db().transaction(async (tx) => {
      await upsertPreference(tx, { userId, key: "tone", value: "verbose" });
    });
    const second = await getPreference(userId, "tone");
    assert.equal(second?.value, "verbose", "last write wins");
    assert.equal(second?.rowVersion, 1, "a second tx upsert bumps rowVersion");
  });

  test("a throw after upsertPreference rolls the write back — no row survives", async () => {
    const userId = await seedUser();

    await assert.rejects(
      db().transaction(async (tx) => {
        await upsertPreference(tx, { userId, key: "tone", value: "concise" });
        throw new Error("boom");
      }),
      /boom/,
    );

    assert.equal(
      await getPreference(userId, "tone"),
      null,
      "the aborted tx leaves no preference row",
    );
  });

  test("deletePreferenceRow inside a rolled-back tx leaves the row present", async () => {
    const userId = await seedUser();
    await setPreference({ userId, key: "tone", value: "concise" });

    await assert.rejects(
      db().transaction(async (tx) => {
        await deletePreferenceRow(tx, userId, "tone");
        throw new Error("boom");
      }),
      /boom/,
    );

    const read = await getPreference(userId, "tone");
    assert.equal(read?.value, "concise", "the aborted delete leaves the row intact");
  });
});
