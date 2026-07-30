import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { eventsOutbox, user } from "@alfred/db/schemas";
import { inArray } from "drizzle-orm";

import { OUTBOX_RETENTION_MS, reapOutboxOnce } from "../../src/events/outbox-reaper";

/**
 * Retention for `events_outbox` (#533), asserted against a real database.
 *
 * Two properties carry the whole contract, and the seeded rows are built so
 * that each row differs from another in exactly one dimension:
 *
 *   - age decides deletion (old vs. fresh, both published), and
 *   - `published_at IS NULL` vetoes deletion whatever the age (old published
 *     vs. old unpublished).
 *
 * An assertion on a global count would prove neither, because the reaper is not
 * user-scoped and a shared database holds other rows. Every case reads back the
 * seeded ids by name.
 */

const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

const HOUR_MS = 60 * 60 * 1000;

interface Seeded {
  oldPublished: number;
  freshPublished: number;
  oldUnpublished: number;
}

/** One row per case, differing from its counterpart in a single dimension. */
async function seed(userId: string, now: Date): Promise<Seeded> {
  const expired = new Date(now.getTime() - OUTBOX_RETENTION_MS - HOUR_MS);
  const inWindow = new Date(now.getTime() - OUTBOX_RETENTION_MS + HOUR_MS);

  const rows = await db()
    .insert(eventsOutbox)
    .values([
      // Past the cutoff and published — the only row that may be deleted.
      { userId, kind: "chat.delta", payload: {}, createdAt: expired, publishedAt: expired },
      // Published like the first row; younger than the cutoff by two hours.
      { userId, kind: "chat.delta", payload: {}, createdAt: inWindow, publishedAt: inWindow },
      // The same age as the first row, but never delivered.
      { userId, kind: "chat.delta", payload: {}, createdAt: expired, publishedAt: null },
    ])
    .returning({ id: eventsOutbox.id });

  assert.equal(rows.length, 3);
  return {
    oldPublished: rows[0]?.id as number,
    freshPublished: rows[1]?.id as number,
    oldUnpublished: rows[2]?.id as number,
  };
}

async function survivors(ids: number[]): Promise<Set<number>> {
  const rows = await db()
    .select({ id: eventsOutbox.id })
    .from(eventsOutbox)
    .where(inArray(eventsOutbox.id, ids));
  return new Set(rows.map((r) => r.id));
}

describe("events_outbox retention", { skip: SKIP }, () => {
  const userIds: string[] = [];

  after(async () => {
    if (userIds.length > 0) await db().delete(user).where(inArray(user.id, userIds));
    await closeConnections();
  });

  async function seedUser(): Promise<string> {
    const userId = `reaper-${randomUUID()}`;
    await db()
      .insert(user)
      .values({ id: userId, name: "Reaper Test", email: `${userId}@example.test` });
    userIds.push(userId);
    return userId;
  }

  test("deletes published rows past the cutoff and keeps everything else", async () => {
    const now = new Date();
    const userId = await seedUser();
    const seeded = await seed(userId, now);

    await reapOutboxOnce(now);

    const alive = await survivors([
      seeded.oldPublished,
      seeded.freshPublished,
      seeded.oldUnpublished,
    ]);
    assert.equal(alive.has(seeded.oldPublished), false, "an expired published row must be deleted");
    assert.equal(
      alive.has(seeded.freshPublished),
      true,
      "a published row inside the window must survive — only age separates it from the deleted row",
    );
    assert.equal(
      alive.has(seeded.oldUnpublished),
      true,
      "an undelivered row must survive at any age — only publication separates it from the deleted row",
    );
  });

  test("a second pass over the same rows deletes nothing", async () => {
    const now = new Date();
    const userId = await seedUser();
    const seeded = await seed(userId, now);

    await reapOutboxOnce(now);
    const afterFirst = await survivors([seeded.freshPublished, seeded.oldUnpublished]);
    await reapOutboxOnce(now);
    const afterSecond = await survivors([seeded.freshPublished, seeded.oldUnpublished]);

    assert.equal(afterFirst.size, 2);
    assert.deepEqual([...afterSecond].sort(), [...afterFirst].sort());
  });

  test("the cutoff moves with the clock it is given", async () => {
    const now = new Date();
    const userId = await seedUser();
    const seeded = await seed(userId, now);

    // Same rows, but a clock two hours later puts `freshPublished` past the
    // cutoff too. If the cutoff were a hard-coded date, or `now` were ignored,
    // this row would survive and the case would fail.
    await reapOutboxOnce(new Date(now.getTime() + 2 * HOUR_MS));

    const alive = await survivors([seeded.freshPublished, seeded.oldUnpublished]);
    assert.equal(alive.has(seeded.freshPublished), false);
    assert.equal(alive.has(seeded.oldUnpublished), true);
  });
});
