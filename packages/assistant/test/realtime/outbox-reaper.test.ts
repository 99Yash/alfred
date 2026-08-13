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

const SKIP = dbBackedSkip("database");

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

/**
 * A signal that reports "not aborted" for its first `reads` reads and aborted
 * after.
 *
 * A plain `AbortController` cannot express "abort between batch 1 and batch 2"
 * without a race, and the placement of the check is precisely what is under
 * test: a check placed *before* the loop, or omitted, changes how many rows the
 * pass deletes. Only `aborted` is overridden, so every other member still
 * behaves like the real signal it proxies.
 */
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

    // Same rows, but a clock two hours later puts `freshPublished` past the
    // cutoff too. If the cutoff were a hard-coded date, or `now` were ignored,
    // this row would survive and the case would fail.
    await reapOutboxOnce(new Date(now.getTime() + 2 * HOUR_MS));

    const alive = await survivors([seeded.freshPublished, seeded.oldUnpublished]);
    assert.equal(alive.has(seeded.freshPublished), false);
    assert.equal(alive.has(seeded.oldUnpublished), true);
  });

  /**
   * The paging bounds — the property the module docstring leads with, and the one
   * that had no coverage.
   *
   * `batchSize` and `maxBatches` are lowered here rather than seeded around: at
   * production values the cap only becomes observable at 100,001 rows. The bounds
   * being parameters is what makes these cases cheap; the defaults are still the
   * contract, and the case below pins them.
   */
  test("a pass stops at maxBatches * batchSize and leaves the rest for the next pass", async () => {
    const now = new Date();
    const userId = await seedUser();
    const expired = new Date(now.getTime() - OUTBOX_RETENTION_MS - HOUR_MS);

    // 10 deletable rows, and a pass allowed to take only 6 of them.
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
    // Oldest-first, because the page is ordered by id. A backlog must drain in
    // insertion order rather than leaving arbitrary holes.
    assert.deepEqual(
      [...alive].sort((a, b) => a - b),
      ids.slice(6),
    );

    // The next pass picks up where this one stopped — that is what makes the cap
    // a spread rather than a leak.
    const second = await reapOutboxOnce(now, { batchSize: 2, maxBatches: 3 });
    assert.equal(second, 4);
    assert.equal((await survivors(ids)).size, 0);
  });

  test("the shipped bounds are 5,000 rows over 20 batches", () => {
    // A pass caps at 100,000 rows an hour. If either constant moves, the pool
    // note and the timing claim in the module docstring need re-checking, so the
    // numbers are pinned rather than merely read from the export.
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

    // Aborted before the first batch: nothing may be deleted at all.
    const upfront = new AbortController();
    upfront.abort();
    assert.equal(await reapOutboxOnce(now, { batchSize: 2, signal: upfront.signal }), 0);
    assert.equal((await survivors(ids)).size, 6, "an already-aborted pass must not delete");

    // Aborted *after* the first batch. `reapOutboxOnce` reads `signal.aborted`
    // once per iteration, so a signal that reports false exactly once proves the
    // check sits between batches — the thing whose absence made the reaper's
    // documented shutdown protection false.
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

    // Both calls start before either awaits a round trip, so the guard is
    // exercised deterministically. Without it both passes would select the same
    // id page and the loser would hold a pool connection to delete nothing.
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

    // A restart must work: the process-level bridge starts and stops this on
    // every boot, and an AbortSignal cannot be un-aborted.
    startOutboxReaper();
    assert.equal(isOutboxReaperRunning(), true);
    await stopOutboxReaper();
    assert.equal(isOutboxReaperRunning(), false);
  });
});
