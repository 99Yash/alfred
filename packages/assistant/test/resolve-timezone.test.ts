import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { inArray, like } from "drizzle-orm";

import { resolveTimezone, setPreference } from "../src/settings";
import { dbBackedSkip } from "./support/db-backed";

/**
 * `settings.resolveTimezone` order (ADR-0082): `timezone`, then legacy `briefing.timezone`,
 * then `DEFAULT_USER_TIMEZONE`. Regression #229: a legacy-only user fell back to UTC.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-resolve-tz-";

const createdUserIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });

  return userId;
}

describe("settings.resolveTimezone (DB-backed)", { skip: SKIP }, () => {
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

  test("both keys set → the canonical `timezone` wins over `briefing.timezone`", async () => {
    const userId = await seedUser();
    await setPreference({ userId, key: "timezone", value: "America/New_York" });
    await setPreference({ userId, key: "briefing.timezone", value: "Asia/Kolkata" });

    assert.equal(await resolveTimezone(userId), "America/New_York");
  });

  test("only `briefing.timezone` set → legacy fallback (never regresses to UTC)", async () => {
    const userId = await seedUser();
    await setPreference({ userId, key: "briefing.timezone", value: "Asia/Kolkata" });

    assert.equal(await resolveTimezone(userId), "Asia/Kolkata");
  });

  test("an invalid canonical `timezone` falls through to the valid `briefing.timezone`", async () => {
    const userId = await seedUser();
    await setPreference({ userId, key: "timezone", value: "Not/AZone" });
    await setPreference({ userId, key: "briefing.timezone", value: "Asia/Kolkata" });

    assert.equal(await resolveTimezone(userId), "Asia/Kolkata");
  });

  test("neither key set → DEFAULT_USER_TIMEZONE (UTC)", async () => {
    const userId = await seedUser();
    assert.equal(await resolveTimezone(userId), "UTC");
  });
});
