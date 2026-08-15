import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { parseMemorySourceOrDefault } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { inArray, like } from "drizzle-orm";

import { deletePreference, getPreference, getPreferences, setPreference } from "../src/settings";
import { dbBackedSkip } from "./support/db-backed";

/**
 * DB-backed integration test for the `settings` preference gateway — the four
 * public verbs over `user_preferences`. Pins the invariant this campaign item
 * preserves: every access resolves through `settings/index.ts` and returns a
 * `PreferenceRow` whose `source` is a validated `MemorySource`, with
 * last-write-wins upserts that bump `row_version`.
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable Postgres with the
 * migrated schema (the local dev DB). Skipped otherwise so the pure-function
 * suite still runs without a database. It seeds throwaway `test-settings-gw-*`
 * users and deletes them (cascade clears their preferences) on teardown.
 *
 * The `-gw-` segment is load-bearing: the sibling `preferences-tx-core.behavior`
 * suite owns `test-settings-tx-`, and `tsx --test` runs the two files as
 * concurrent processes against one database. A bare `test-settings-` prefix here
 * would make the `before` cleanup below delete the tx suite's rows mid-run.
 * `pnpm check:test-id-prefixes` fails on any such pair.
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
    // Clear any rows a previously-crashed run left behind.
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

  test("setPreference then getPreference returns the written value", async () => {
    const userId = await seedUser();
    const written = await setPreference({ userId, key: "tone", value: "concise" });
    assert.equal(written.value, "concise");

    const read = await getPreference(userId, "tone");
    assert.ok(read, "the written preference must be readable");
    assert.equal(read.value, "concise");
    assert.equal(read.key, "tone");
    assert.equal(read.userId, userId);
  });

  test("source omitted defaults to { kind: 'user' }", async () => {
    const userId = await seedUser();
    const written = await setPreference({ userId, key: "tone", value: "warm" });
    assert.deepEqual(written.source, { kind: "user" });

    const read = await getPreference(userId, "tone");
    assert.deepEqual(read?.source, { kind: "user" });
  });

  test("an agent-suggested source round-trips through the gateway", async () => {
    const userId = await seedUser();
    const written = await setPreference({
      userId,
      key: "reply_length",
      value: "short",
      source: { kind: "agent" },
    });
    assert.deepEqual(written.source, { kind: "agent" });
    const read = await getPreference(userId, "reply_length");
    assert.deepEqual(read?.source, { kind: "agent" });
  });

  test("a second setPreference on the same (userId,key) upserts and bumps rowVersion", async () => {
    const userId = await seedUser();
    const first = await setPreference({ userId, key: "tone", value: "concise" });
    assert.equal(first.rowVersion, 0, "first write starts at rowVersion 0");

    const second = await setPreference({ userId, key: "tone", value: "verbose" });
    assert.equal(second.value, "verbose", "last write wins");
    assert.equal(second.rowVersion, 1, "conflicting write bumps rowVersion");

    const rows = await getPreferences(userId);
    assert.equal(rows.length, 1, "upsert keeps a single row per (userId,key)");
  });

  test("getPreferences returns a user's rows ordered by key ascending", async () => {
    const userId = await seedUser();
    // Insert out of key order; the read must sort them.
    await setPreference({ userId, key: "tone", value: "concise" });
    await setPreference({ userId, key: "briefing_hour", value: 7 });
    await setPreference({ userId, key: "reply_length", value: "short" });

    const rows = await getPreferences(userId);
    assert.deepEqual(
      rows.map((r) => r.key),
      ["briefing_hour", "reply_length", "tone"],
      "getPreferences must order by key asc",
    );
  });

  test("deletePreference returns true then getPreference is null; deleting an absent key is false", async () => {
    const userId = await seedUser();
    await setPreference({ userId, key: "tone", value: "concise" });

    assert.equal(await deletePreference(userId, "tone"), true, "delete of an existing key is true");
    assert.equal(await getPreference(userId, "tone"), null, "the deleted key reads back as null");
    assert.equal(
      await deletePreference(userId, "tone"),
      false,
      "delete of an already-absent key is false",
    );
  });

  // The stored `source` column carries a DB check constraint
  // (`user_preferences_source_shape`) that rejects any value whose `kind` is not
  // in the enum, so a malformed provenance row cannot be seeded through an
  // insert. The fallback path in `parseMemorySourceOrDefault` — now owned by
  // `@alfred/contracts` and used by every stored-source reader — is exercised
  // directly here instead. See the "Deviation" note in the item design.
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
