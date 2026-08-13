import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { FEATURE_FLAG_KEYS } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { inArray, like } from "drizzle-orm";

import { resolveFeatureFlags, setPreference } from "../src/settings";
import { dbBackedSkip } from "./support/db-backed";

/**
 * DB-backed integration test for feature-flag resolution after it folded into
 * the `settings` module (campaign item 02). Pins the invariant the move
 * preserves: given the four `feature.*` preference keys, `resolveFeatureFlags`
 * returns the same four booleans the deleted `features` module returned —
 * UNSET means ON, and only an explicit `false` / `"false"` / `0` means OFF —
 * and the resolver is reachable only through the `settings` interface
 * (`../src/settings`), never a deep `../features/flags` path.
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable Postgres with the
 * migrated schema (the local dev DB). Skipped otherwise so the pure-function
 * suite still runs without a database. It seeds throwaway `test-flags-*` users
 * and deletes them (cascade clears their preferences) on teardown.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-flags-";
const createdUserIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  return userId;
}

describe("settings feature flags (DB-backed)", { skip: SKIP }, () => {
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

  test("a user with no preference rows resolves all four flags ON (UNSET = ON)", async () => {
    const userId = await seedUser();
    const flags = await resolveFeatureFlags(userId);
    assert.deepEqual(flags, {
      morningBriefing: true,
      eveningRecap: true,
      emailTagging: true,
      actionItems: true,
    });
  });

  test('an explicit false / "false" / 0 turns exactly that flag OFF', async () => {
    const userId = await seedUser();
    await setPreference({ userId, key: FEATURE_FLAG_KEYS.morningBriefing, value: false });
    await setPreference({ userId, key: FEATURE_FLAG_KEYS.eveningRecap, value: "false" });
    await setPreference({ userId, key: FEATURE_FLAG_KEYS.emailTagging, value: 0 });
    // actionItems is left UNSET and must stay ON.

    const flags = await resolveFeatureFlags(userId);
    assert.deepEqual(flags, {
      morningBriefing: false,
      eveningRecap: false,
      emailTagging: false,
      actionItems: true,
    });
  });

  test("any truthy stored value resolves the flag ON", async () => {
    const userId = await seedUser();
    await setPreference({ userId, key: FEATURE_FLAG_KEYS.morningBriefing, value: true });
    await setPreference({ userId, key: FEATURE_FLAG_KEYS.eveningRecap, value: "true" });
    await setPreference({ userId, key: FEATURE_FLAG_KEYS.emailTagging, value: 1 });
    await setPreference({ userId, key: FEATURE_FLAG_KEYS.actionItems, value: "on" });

    const flags = await resolveFeatureFlags(userId);
    assert.deepEqual(flags, {
      morningBriefing: true,
      eveningRecap: true,
      emailTagging: true,
      actionItems: true,
    });
  });
});
