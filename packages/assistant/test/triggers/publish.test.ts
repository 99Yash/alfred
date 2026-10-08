import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { eventsOutbox, user } from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";

import { publishEvent } from "../../src/triggers";
import { dbBackedSkip } from "../support/db-backed";

/** `publishEvent` with `tx` or `untransacted: true` writes one row; a rolled-back `tx` leaves none. */

const SKIP = dbBackedSkip("database");

describe("publishEvent executor selection", { skip: SKIP }, () => {
  const userIds: string[] = [];

  after(async () => {
    if (userIds.length > 0) await db().delete(user).where(inArray(user.id, userIds));
    await closeConnections();
  });

  async function seedUser(): Promise<string> {
    const userId = `publish-${randomUUID()}`;
    await db()
      .insert(user)
      .values({ id: userId, name: "Publish Test", email: `${userId}@example.test` });
    userIds.push(userId);

    return userId;
  }

  async function rowsFor(userId: string): Promise<number> {
    const rows = await db()
      .select({ id: eventsOutbox.id })
      .from(eventsOutbox)
      .where(and(eq(eventsOutbox.userId, userId), eq(eventsOutbox.kind, "inbox.updated")));

    return rows.length;
  }

  test("the untransacted arm writes exactly one row on the pool root", async () => {
    const userId = await seedUser();

    await publishEvent({
      untransacted: true,
      userId,
      kind: "inbox.updated",
      payload: { reason: "triaged", count: 1 },
    });

    assert.equal(await rowsFor(userId), 1);
  });

  test("the tx arm writes exactly one row through the passed handle", async () => {
    const userId = await seedUser();

    await db().transaction(async (tx) => {
      await publishEvent({
        tx,
        userId,
        kind: "inbox.updated",
        payload: { reason: "triaged", count: 1 },
      });
    });

    assert.equal(await rowsFor(userId), 1);
  });

  test("the tx arm's row rolls back with a failed transaction — atomic with the domain write", async () => {
    const userId = await seedUser();

    await assert.rejects(
      db().transaction(async (tx) => {
        await publishEvent({
          tx,
          userId,
          kind: "inbox.updated",
          payload: { reason: "triaged", count: 1 },
        });
        // The outbox row must roll back with the failed domain write.
        throw new Error("domain write failed");
      }),
      /domain write failed/,
    );

    assert.equal(await rowsFor(userId), 0);
  });
});
