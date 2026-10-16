import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { FEATURE_FLAG_KEYS } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { inArray, like } from "drizzle-orm";

import { settings } from "../src/settings";
import { dbBackedSkip } from "./support/db-backed";

/** `settings({ userId }).flags()`: an unset flag is on; only `false`, `"false"`, or `0` turns it off. */
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

  test("a user with no preference rows resolves all four flags ON (UNSET = ON)", async () => {
    const userId = await seedUser();
    const flags = await settings({ userId }).flags();
    assert.deepEqual(flags, {
      morningBriefing: true,
      eveningRecap: true,
      emailTagging: true,
      actionItems: true,
      replyDrafting: false,
    });
  });

  test('an explicit false / "false" / 0 turns exactly that flag OFF', async () => {
    const userId = await seedUser();
    await settings({ userId }).set(FEATURE_FLAG_KEYS.morningBriefing, false);
    await settings({ userId }).set(FEATURE_FLAG_KEYS.eveningRecap, "false");
    await settings({ userId }).set(FEATURE_FLAG_KEYS.emailTagging, 0);
    // actionItems is unset, so it stays on.

    const flags = await settings({ userId }).flags();
    assert.deepEqual(flags, {
      morningBriefing: false,
      eveningRecap: false,
      emailTagging: false,
      actionItems: true,
      replyDrafting: false,
    });
  });

  test("any truthy stored value resolves the flag ON", async () => {
    const userId = await seedUser();
    await settings({ userId }).set(FEATURE_FLAG_KEYS.morningBriefing, true);
    await settings({ userId }).set(FEATURE_FLAG_KEYS.eveningRecap, "true");
    await settings({ userId }).set(FEATURE_FLAG_KEYS.emailTagging, 1);
    await settings({ userId }).set(FEATURE_FLAG_KEYS.actionItems, "on");

    const flags = await settings({ userId }).flags();
    assert.deepEqual(flags, {
      morningBriefing: true,
      eveningRecap: true,
      emailTagging: true,
      actionItems: true,
      replyDrafting: false,
    });
  });
});
