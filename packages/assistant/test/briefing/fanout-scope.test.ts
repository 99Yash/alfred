import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { inArray } from "drizzle-orm";

import { selectBriefingFanoutUsers } from "../../src/briefings/queue";
import { dbBackedSkip } from "../support/db-backed";

/**
 * The hourly briefing tick is the one place that turns a bare `user` row into
 * paid LLM work and an outbound email, so its fan-out scope is a spend and
 * deliverability boundary, not a convenience filter.
 *
 * Regression cover for a live incident: a DB-backed suite seeded `user` rows and
 * never deleted them, the tick selected every row unconditionally, and 83
 * leftover `@example.test` users each drew an evening briefing every hour. That
 * alone exceeded the Cloudflare AI-gateway rate limit and billed real tokens
 * against addresses nobody owns.
 */

const SKIP = dbBackedSkip("database");
const ID_PREFIX = "test-fanout-scope-";
const createdUserIds: string[] = [];

async function seedUser(emailVerified: boolean): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({
      id: userId,
      name: "Fanout Scope Test",
      email: `${userId}@example.test`,
      emailVerified,
    });
  return userId;
}

after(async () => {
  try {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
  } finally {
    await closeConnections();
  }
});

describe("briefing fan-out scope (DB-backed)", { skip: SKIP }, () => {
  test("selects a verified user and never an unverified one", async () => {
    // Seeded in the same case so the two rows differ in exactly one column.
    // Asserting only the absence of the unverified id would pass against a
    // query that returns nothing at all, so the verified id is what proves the
    // predicate still selects.
    const verifiedId = await seedUser(true);
    const unverifiedId = await seedUser(false);

    const selected = await selectBriefingFanoutUsers();
    const ids = new Set(selected.map((row) => row.id));

    assert.ok(
      ids.has(verifiedId),
      "a user with a verified email must still receive briefings — a predicate that drops them silently stops the product working",
    );
    assert.ok(
      !ids.has(unverifiedId),
      "a user with an unverified email must never be fanned out to — that row is an address nobody has proven they control, and the tick spends money and sends mail",
    );
  });

  test("every selected user has a verified email", async () => {
    // Both arms seeded here rather than leaning on whatever the database
    // already holds: without the verified row, an empty selection would satisfy
    // the "none are unverified" assertion vacuously.
    await seedUser(true);
    await seedUser(false);

    const selected = await selectBriefingFanoutUsers();
    assert.ok(
      selected.length > 0,
      "expected the fan-out to select at least the seeded verified user",
    );

    const rows = await db()
      .select({ id: user.id, emailVerified: user.emailVerified })
      .from(user)
      .where(
        inArray(
          user.id,
          selected.map((row) => row.id),
        ),
      );
    const unverified = rows.filter((row) => !row.emailVerified).map((row) => row.id);

    assert.deepEqual(
      unverified,
      [],
      "the fan-out returned users whose email is unverified; the tick would bill tokens and send mail for them",
    );
  });
});
