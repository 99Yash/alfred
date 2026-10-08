import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { eventsOutbox, user } from "@alfred/db/schemas";
import { inArray } from "drizzle-orm";

import {
  isOutboxReaperRunning,
  MAX_BATCHES_PER_PASS,
  OUTBOX_RETENTION_MS,
  REAP_BATCH_SIZE,
  reapOutboxOnce,
  startOutboxReaper,
  stopOutboxReaper,
} from "../../src/realtime/outbox-reaper";
import { dbBackedSkip } from "../support/db-backed";

/**
 * `events_outbox` retention (#533): age decides deletion, and an unpublished row is never deleted.
 * Read back seeded ids, not a global count: the reaper is not user-scoped.
 */

const SKIP = dbBackedSkip("database");

const HOUR_MS = 60 * 60 * 1000;

interface Seeded {
  oldPublished: number;
  freshPublished: number;
  oldUnpublished: number;
}

/** Each row differs from its counterpart in one dimension. */
async function seed(userId: string, now: Date): Promise<Seeded> {
  const expired = new Date(now.getTime() - OUTBOX_RETENTION_MS - HOUR_MS);
  const inWindow = new Date(now.getTime() - OUTBOX_RETENTION_MS + HOUR_MS);

  const rows = await db()
    .insert(eventsOutbox)
    .values([
      // The only deletable row.
      { userId, kind: "chat.delta", payload: {}, createdAt: expired, publishedAt: expired },
      // Two hours younger than the cutoff.
      { userId, kind: "chat.delta", payload: {}, createdAt: inWindow, publishedAt: inWindow },
      // Same age, never published.
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

/** Not aborted for the first `reads` reads, then aborted. An `AbortController` would race. */
function signalAbortingAfterReads(reads: number): AbortSignal {
  const controller = new AbortController();
  let seen = 0;

  return new Proxy(controller.signal, {
    get(target, prop, receiver) {
      if (prop === "aborted") return seen++ >= reads;
      const value = Reflect.get(target, prop, receiver);

      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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

    // A clock two hours later puts `freshPublished` past the cutoff, so `now` must be honored.
    await reapOutboxOnce(new Date(now.getTime() + 2 * HOUR_MS));

    const alive = await survivors([seeded.freshPublished, seeded.oldUnpublished]);
    assert.equal(alive.has(seeded.freshPublished), false);
    assert.equal(alive.has(seeded.oldUnpublished), true);
  });

  /** Small bounds here, because the production cap shows only at 100,001 rows. */
  test("a pass stops at maxBatches * batchSize and leaves the rest for the next pass", async () => {
    const now = new Date();
    const userId = await seedUser();
    const expired = new Date(now.getTime() - OUTBOX_RETENTION_MS - HOUR_MS);

    const rows = await db()
      .insert(eventsOutbox)
      .values(
        Array.from({ length: 10 }, () => ({
          userId,
          kind: "chat.delta" as const,
          payload: {},
          createdAt: expired,
          publishedAt: expired,
        })),
      )
      .returning({ id: eventsOutbox.id });

    const ids = rows.map((r) => r.id);

    const deleted = await reapOutboxOnce(now, { batchSize: 2, maxBatches: 3 });

    assert.equal(deleted, 6, "3 batches of 2 must stop at 6, not drain all 10");
    const alive = await survivors(ids);
    assert.equal(alive.size, 4, "the remainder must survive the capped pass");
    // Oldest first: a backlog drains in insertion order.
    assert.deepEqual(
      [...alive].sort((a, b) => a - b),
      ids.slice(6),
    );

    // The next pass continues, so the cap spreads the work instead of leaking rows.
    const second = await reapOutboxOnce(now, { batchSize: 2, maxBatches: 3 });
    assert.equal(second, 4);
    assert.equal((await survivors(ids)).size, 0);
  });

  test("the shipped bounds are 5,000 rows over 20 batches", () => {
    // Pinned: a change needs a recheck of the module docstring's pool and timing notes.
    assert.equal(REAP_BATCH_SIZE, 5_000);
    assert.equal(MAX_BATCHES_PER_PASS, 20);
  });

  test("an aborted signal stops the pass between batches", async () => {
    const now = new Date();
    const userId = await seedUser();
    const expired = new Date(now.getTime() - OUTBOX_RETENTION_MS - HOUR_MS);

    const rows = await db()
      .insert(eventsOutbox)
      .values(
        Array.from({ length: 6 }, () => ({
          userId,
          kind: "chat.delta" as const,
          payload: {},
          createdAt: expired,
          publishedAt: expired,
        })),
      )
      .returning({ id: eventsOutbox.id });

    const ids = rows.map((r) => r.id);

    const upfront = new AbortController();
    upfront.abort();
    assert.equal(await reapOutboxOnce(now, { batchSize: 2, signal: upfront.signal }), 0);
    assert.equal((await survivors(ids)).size, 6, "an already-aborted pass must not delete");

    // One false read proves the abort check sits between batches.
    const deleted = await reapOutboxOnce(now, {
      batchSize: 2,
      signal: signalAbortingAfterReads(1),
    });

    assert.equal(deleted, 2, "exactly one batch may land before the abort is noticed");
    assert.equal((await survivors(ids)).size, 4);
  });

  test("a second concurrent pass yields instead of racing the first", async () => {
    const now = new Date();
    const userId = await seedUser();
    const seeded = await seed(userId, now);

    // Both calls start before any await, so the guard is hit every time.
    const [first, second] = await Promise.all([reapOutboxOnce(now), reapOutboxOnce(now)]);

    assert.equal(second, 0, "the second caller must yield — the guard is on the entrypoint");
    assert.ok(first >= 1, "the first caller still does the work");
    assert.equal((await survivors([seeded.oldPublished])).size, 0);
  });

  test("start is idempotent and stop leaves the reaper stoppable again", async () => {
    assert.equal(isOutboxReaperRunning(), false, "not running before start");

    startOutboxReaper();
    startOutboxReaper();
    assert.equal(isOutboxReaperRunning(), true);

    await stopOutboxReaper();
    assert.equal(isOutboxReaperRunning(), false);

    // The bridge restarts this, and an AbortSignal cannot be un-aborted.
    startOutboxReaper();
    assert.equal(isOutboxReaperRunning(), true);
    await stopOutboxReaper();
    assert.equal(isOutboxReaperRunning(), false);
  });
});
