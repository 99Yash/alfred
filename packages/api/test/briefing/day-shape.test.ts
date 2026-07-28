import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { user, webhookEvents } from "@alfred/db/schemas";
import { databaseEnv } from "@alfred/env/database";
import { inArray, like } from "drizzle-orm";

import { closeReplicachePokeBridge } from "../../src/events/replicache-events";
import { gatherDayShape } from "../../src/modules/briefing/gather";
import { objectStateStore } from "../../src/modules/integrations/object-state";
import { closeRedis } from "../../src/queue/connection";

/**
 * Characterization of `gatherDayShape` (ADR-0064 / #230) — the deterministic
 * "how busy was this day" read the composer cannot argue with. It had no test
 * of its own: `suppression-gather.test.ts` only asserts the
 * `demandingEmailCount` that `gatherBriefingWithSuppressionAudit` folds on top.
 *
 * Pinned before campaign arch-20260727 item 06 moves the gather into the
 * composing agent, because both halves of the shape — the activity-volume
 * thresholds and the `stateDeliveredAt` window on `shipped` — are behaviour a
 * reseat could silently change.
 */

function hasDatabaseUrl(): boolean {
  try {
    return Boolean(databaseEnv().DATABASE_URL);
  } catch {
    return false;
  }
}

const SKIP = hasDatabaseUrl() ? false : "DATABASE_URL not set — skipping DB-backed test";
const ID_PREFIX = "test-briefing-day-shape-";
const createdUserIds: string[] = [];

const WINDOW_START = new Date("2026-06-27T00:00:00.000Z");
const WINDOW_END = new Date("2026-06-28T00:00:00.000Z");
const IN_WINDOW = new Date("2026-06-27T12:00:00.000Z");
const BEFORE_WINDOW = new Date("2026-06-26T12:00:00.000Z");
const AFTER_WINDOW = new Date("2026-06-28T12:00:00.000Z");

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Day Shape Test", email: `${userId}@example.test` });
  return userId;
}

function prPayload(number: number, opts: { merged?: boolean } = {}) {
  return {
    pull_request: {
      id: number,
      number,
      title: `PR ${number}`,
      html_url: `https://github.com/o/r/pull/${number}`,
      merged: opts.merged ?? false,
      head: { sha: `${number}`.padStart(40, "a"), ref: "feature" },
    },
    repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
  };
}

/** Drive the production write path so `stateDeliveredAt` is set the real way. */
async function mergePr(userId: string, number: number, deliveredAt: Date): Promise<void> {
  await objectStateStore.applyEvent({
    userId,
    provider: "github",
    eventType: "pull_request",
    action: "closed",
    payload: prPayload(number, { merged: true }),
    deliveredAt,
  });
}

async function seedWebhookEvent(userId: string, deliveredAt: Date): Promise<void> {
  await db()
    .insert(webhookEvents)
    .values({
      provider: "github",
      providerEventId: randomUUID(),
      eventType: "push",
      action: null,
      repo: "o/r",
      userId,
      payload: { ref: "refs/heads/main", commits: [{}], compare: "https://github.com/o/r/compare" },
      deliveredAt,
    });
}

describe("gatherDayShape (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
  });

  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeReplicachePokeBridge();
    await closeRedis();
    await closeConnections();
  });

  async function shapeFor(userId: string, activityCount?: number) {
    return gatherDayShape({
      userId,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      ...(activityCount === undefined ? {} : { activityCount }),
    });
  }

  test("zero activity is the only 'quiet' — one item is already 'normal'", async () => {
    const userId = await seedUser();

    assert.equal((await shapeFor(userId, 0)).activityVolume, "quiet");
    assert.equal((await shapeFor(userId, 1)).activityVolume, "normal");
  });

  test("the busy threshold is 8, and 7 is still normal", async () => {
    const userId = await seedUser();

    assert.equal((await shapeFor(userId, 7)).activityVolume, "normal");
    assert.equal((await shapeFor(userId, 8)).activityVolume, "busy");
    assert.equal((await shapeFor(userId, 99)).activityVolume, "busy");
  });

  test("an omitted activityCount falls back to a fresh windowed webhook query", async () => {
    const userId = await seedUser();
    assert.equal((await shapeFor(userId)).activityVolume, "quiet");

    await seedWebhookEvent(userId, IN_WINDOW);
    await seedWebhookEvent(userId, BEFORE_WINDOW);
    await seedWebhookEvent(userId, AFTER_WINDOW);

    // Only the in-window delivery counts, so the day is `normal`, not `busy`.
    assert.equal((await shapeFor(userId)).activityVolume, "normal");
  });

  test("a supplied activityCount wins over what the webhook log actually holds", async () => {
    const userId = await seedUser();
    for (let i = 0; i < 9; i++) await seedWebhookEvent(userId, IN_WINDOW);

    // `gatherBriefingWithSuppressionAudit` passes the already-fetched count to
    // avoid re-querying; that count is trusted verbatim.
    assert.equal((await shapeFor(userId, 0)).activityVolume, "quiet");
  });

  test("shipped lists GitHub objects resolved inside the window, with title and url", async () => {
    const userId = await seedUser();
    await mergePr(userId, 11, IN_WINDOW);

    const shape = await shapeFor(userId, 0);
    assert.deepEqual(shape.shipped, [{ title: "PR 11", url: "https://github.com/o/r/pull/11" }]);
    // A resolved object does not make the day busy — the two halves are independent.
    assert.equal(shape.activityVolume, "quiet");
  });

  test("shipped is windowed on the resolving delivery, not the object's existence", async () => {
    const userId = await seedUser();
    await mergePr(userId, 21, BEFORE_WINDOW);
    await mergePr(userId, 22, AFTER_WINDOW);
    await mergePr(userId, 23, IN_WINDOW);

    const shape = await shapeFor(userId, 0);
    assert.deepEqual(
      shape.shipped.map((s) => s.title),
      ["PR 23"],
    );
  });

  test("a still-open PR never reaches shipped (absence never closes)", async () => {
    const userId = await seedUser();
    await objectStateStore.applyEvent({
      userId,
      provider: "github",
      eventType: "pull_request",
      action: "opened",
      payload: prPayload(31),
      deliveredAt: IN_WINDOW,
    });

    assert.deepEqual((await shapeFor(userId, 0)).shipped, []);
  });

  test("a closed-unmerged PR is abandoned, not shipped", async () => {
    const userId = await seedUser();
    await objectStateStore.applyEvent({
      userId,
      provider: "github",
      eventType: "pull_request",
      action: "closed",
      payload: prPayload(41, { merged: false }),
      deliveredAt: IN_WINDOW,
    });

    assert.deepEqual((await shapeFor(userId, 0)).shipped, []);
  });

  test("shipped is capped at 6", async () => {
    const userId = await seedUser();
    for (let i = 51; i <= 58; i++) await mergePr(userId, i, IN_WINDOW);

    assert.equal((await shapeFor(userId, 0)).shipped.length, 6);
  });

  test("shape is scoped per user", async () => {
    const mine = await seedUser();
    const theirs = await seedUser();
    await mergePr(theirs, 61, IN_WINDOW);
    await seedWebhookEvent(theirs, IN_WINDOW);

    const shape = await shapeFor(mine);
    assert.equal(shape.activityVolume, "quiet");
    assert.deepEqual(shape.shipped, []);
  });
});
