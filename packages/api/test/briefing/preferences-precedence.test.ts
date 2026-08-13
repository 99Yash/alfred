import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { inArray, like } from "drizzle-orm";

import { resolveBriefingPreferences } from "@alfred/assistant/briefings/preferences";
import { setPreference } from "@alfred/assistant/settings";
import { dbBackedSkip } from "../support/db-backed";

/**
 * DB-backed integration test for `briefing.resolveBriefingPreferences` — the
 * briefing-delivery zone resolver. Pins that briefing reads the ADR-0082 zone
 * precedence from the same key-set/order end-to-end as `settings.resolveTimezone`
 * (both map `TIMEZONE_PREFERENCE_KEYS` through the shared `firstValidTimezone`),
 * so a legacy `briefing.timezone`-only user can never silently regress to UTC
 * (the #229 bug): the resolved zone is the canonical `timezone` preference, then
 * the legacy `briefing.timezone` fallback. This mirrors
 * `test/settings/resolve-timezone.test.ts` on the briefing side — the report
 * gate's "identical precedence at both sites."
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable Postgres with the
 * migrated schema (the local dev DB). Skipped otherwise so the pure-function
 * suite still runs without a database. It seeds throwaway `test-briefing-tz-*`
 * users and deletes them (cascade clears their preferences) on teardown.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-briefing-tz-";
const createdUserIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  return userId;
}

describe(
  "briefing.resolveBriefingPreferences timezone precedence (DB-backed)",
  { skip: SKIP },
  () => {
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

    test("only `briefing.timezone` set → legacy fallback (never regresses to UTC)", async () => {
      const userId = await seedUser();
      await setPreference({ userId, key: "briefing.timezone", value: "Asia/Kolkata" });

      const prefs = await resolveBriefingPreferences(userId);
      assert.equal(prefs.timezone, "Asia/Kolkata");
      assert.equal(prefs.hasUserOverride, true);
    });

    test("both keys set → the canonical `timezone` wins over `briefing.timezone`", async () => {
      const userId = await seedUser();
      await setPreference({ userId, key: "timezone", value: "America/New_York" });
      await setPreference({ userId, key: "briefing.timezone", value: "Asia/Kolkata" });

      const prefs = await resolveBriefingPreferences(userId);
      assert.equal(prefs.timezone, "America/New_York");
      assert.equal(prefs.hasUserOverride, true);
    });

    test("neither key set → DEFAULT_USER_TIMEZONE (UTC), no override", async () => {
      const userId = await seedUser();

      const prefs = await resolveBriefingPreferences(userId);
      assert.equal(prefs.timezone, "UTC");
      assert.equal(prefs.hasUserOverride, false);
    });
  },
);
