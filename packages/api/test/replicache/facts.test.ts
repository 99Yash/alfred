import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { user, userFacts } from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";

import { serverMutators } from "../../src/modules/replicache/server-mutators";

const SKIP = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL not set — skipping DB-backed test";

const ID_PREFIX = "test-rfact-";
const createdUserIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  return userId;
}

async function rowsForKey(userId: string, key: string) {
  return db()
    .select({
      id: userFacts.id,
      key: userFacts.key,
      value: userFacts.value,
      status: userFacts.status,
      supersedesId: userFacts.supersedesId,
    })
    .from(userFacts)
    .where(and(eq(userFacts.userId, userId), eq(userFacts.key, key)));
}

describe("serverMutators fact invariants (DB-backed, #330)", { skip: SKIP }, () => {
  after(async () => {
    if (createdUserIds.length) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeConnections();
  });

  test("factConfirm supersedes the prior confirmed single-valued truth", async () => {
    const userId = await seedUser();
    const oldId = `${ID_PREFIX}old-${randomUUID()}`;
    const proposedId = `${ID_PREFIX}new-${randomUUID()}`;
    await db().insert(userFacts).values([
      {
        id: oldId,
        userId,
        key: "employer",
        value: "Oliv AI",
        confidence: 1,
        status: "confirmed",
        source: { kind: "user" },
      },
      {
        id: proposedId,
        userId,
        key: "employer",
        value: "NewCo",
        confidence: 0.95,
        status: "proposed",
        source: { kind: "document", id: "doc_1" },
      },
    ]);

    await db().transaction((tx) =>
      serverMutators.factConfirm(tx, { factId: proposedId }, { userId }),
    );

    const rows = await rowsForKey(userId, "employer");
    const old = rows.find((row) => row.id === oldId);
    const confirmed = rows.find((row) => row.id === proposedId);
    assert.equal(old?.status, "superseded");
    assert.equal(confirmed?.status, "confirmed");
    assert.equal(confirmed?.supersedesId, oldId);
  });

  test("factCreate canonicalizes aliases and supersedes conflicting active truth", async () => {
    const userId = await seedUser();
    const oldId = `${ID_PREFIX}old-${randomUUID()}`;
    const newId = `${ID_PREFIX}new-${randomUUID()}`;
    await db().insert(userFacts).values({
      id: oldId,
      userId,
      key: "employer",
      value: "Oliv AI",
      confidence: 1,
      status: "confirmed",
      source: { kind: "user" },
    });

    await db().transaction((tx) =>
      serverMutators.factCreate(
        tx,
        { id: newId, userId, key: "company", value: "NewCo" },
        { userId },
      ),
    );

    const rows = await rowsForKey(userId, "employer");
    const old = rows.find((row) => row.id === oldId);
    const created = rows.find((row) => row.id === newId);
    assert.equal(old?.status, "superseded");
    assert.equal(created?.key, "employer");
    assert.equal(created?.status, "confirmed");
    assert.equal(created?.supersedesId, oldId);
  });
});
