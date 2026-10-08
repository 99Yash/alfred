import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { inArray } from "drizzle-orm";

import { selectEmailableUsers } from "../../src/delivery/emailable-users";
import { dbBackedSkip } from "../support/db-backed";

/**
 * The fan-out scope turns a `user` row into paid LLM work and an email, so it is a spend boundary.
 * The briefing tick and the delivery-alert sweep (ADR-0100) share it.
 * Regression: leftover test users each drew a briefing every hour.
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
    // The verified row proves the query still selects something.
    const verifiedId = await seedUser(true);
    const unverifiedId = await seedUser(false);

    const selected = await selectEmailableUsers();
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
    // Without the verified row, an empty selection would pass.
    await seedUser(true);
    await seedUser(false);

    const selected = await selectEmailableUsers();
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
