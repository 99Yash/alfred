import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { parseMemorySourceOrDefault } from "../src/settings/memory-source";
import { closeConnections, db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { inArray, like } from "drizzle-orm";

import { settings } from "../src/settings";
import { dbBackedSkip } from "./support/db-backed";

/**
 * The `settings` preference verbs return a validated `source` and bump `row_version` on upsert.
 * The `-gw-` prefix matters: `preferences-tx-core.behavior` runs at the same time
 * with `test-settings-tx-`, and a bare prefix would delete its rows mid-run.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-settings-gw-";

const createdUserIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });

  return userId;
}

describe("settings preferences (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    // Clear rows a crashed run left behind.
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

  test("set then get returns the written value", async () => {
    const userId = await seedUser();
    const written = await settings({ userId }).set("tone", "concise");
    assert.equal(written.value, "concise");

    const read = await settings({ userId }).get("tone");
    assert.ok(read, "the written preference must be readable");
    assert.equal(read.value, "concise");
    assert.equal(read.key, "tone");
    assert.equal(read.userId, userId);
  });

  test("source omitted defaults to { kind: 'user' }", async () => {
    const userId = await seedUser();
    const written = await settings({ userId }).set("tone", "warm");
    assert.deepEqual(written.source, { kind: "user" });

    const read = await settings({ userId }).get("tone");
    assert.deepEqual(read?.source, { kind: "user" });
  });

  test("an agent-suggested source round-trips through the gateway", async () => {
    const userId = await seedUser();

    const written = await settings({ userId }).set("reply_length", "short", {
      source: { kind: "agent" },
    });

    assert.deepEqual(written.source, { kind: "agent" });
    const read = await settings({ userId }).get("reply_length");
    assert.deepEqual(read?.source, { kind: "agent" });
  });

  test("a second set on the same (userId,key) upserts and bumps rowVersion", async () => {
    const userId = await seedUser();
    const first = await settings({ userId }).set("tone", "concise");
    assert.equal(first.rowVersion, 0, "first write starts at rowVersion 0");

    const second = await settings({ userId }).set("tone", "verbose");
    assert.equal(second.value, "verbose", "last write wins");
    assert.equal(second.rowVersion, 1, "conflicting write bumps rowVersion");

    const rows = await settings({ userId }).all();
    assert.equal(rows.length, 1, "upsert keeps a single row per (userId,key)");
  });

  test("all returns a user's rows ordered by key ascending", async () => {
    const userId = await seedUser();
    // Insert out of key order; the read must sort them.
    await settings({ userId }).set("tone", "concise");
    await settings({ userId }).set("briefing_hour", 7);
    await settings({ userId }).set("reply_length", "short");

    const rows = await settings({ userId }).all();
    assert.deepEqual(
      rows.map((r) => r.key),
      ["briefing_hour", "reply_length", "tone"],
      "all must order by key asc",
    );
  });

  test("delete returns true then get is null; deleting an absent key is false", async () => {
    const userId = await seedUser();
    await settings({ userId }).set("tone", "concise");

    assert.equal(
      await settings({ userId }).delete("tone"),
      true,
      "delete of an existing key is true",
    );
    assert.equal(
      await settings({ userId }).get("tone"),
      null,
      "the deleted key reads back as null",
    );
    assert.equal(
      await settings({ userId }).delete("tone"),
      false,
      "delete of an already-absent key is false",
    );
  });

  // `user_preferences_source_shape` blocks a malformed row, so call the fallback directly.
  test("parseMemorySourceOrDefault falls back on a malformed stored source", () => {
    assert.deepEqual(
      parseMemorySourceOrDefault({ kind: "invented" }, { kind: "user" }, "test"),
      { kind: "user" },
      "an out-of-enum kind must fall back to the provided default",
    );
    assert.deepEqual(
      parseMemorySourceOrDefault({ kind: "agent" }, { kind: "user" }, "test"),
      { kind: "agent" },
      "a valid source is returned unchanged",
    );
  });
});
