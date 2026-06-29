import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { replicacheClientGroup, user } from "@alfred/db/schemas";
import { eq, inArray } from "drizzle-orm";

import { handlePull } from "../../src/modules/replicache/pull";
import { closeRedis } from "../../src/queue/connection";

const SKIP =
  process.env.DATABASE_URL && process.env.REDIS_URL
    ? false
    : "DATABASE_URL/REDIS_URL not set — skipping DB+Redis-backed test";

const ID_PREFIX = "test-rpull-";
const createdUserIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  return userId;
}

describe("handlePull cookie monotonicity across client-group forks (#337)", { skip: SKIP }, () => {
  after(async () => {
    if (createdUserIds.length) {
      // replicache_client_group cascades from user.
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeRedis();
    await closeConnections();
  });

  test("a forked client group's first pull cookie cannot regress below the stale cookie", async () => {
    const userId = await seedUser();
    const oldGroup = `${ID_PREFIX}old-${randomUUID()}`;
    const newGroup = `${ID_PREFIX}new-${randomUUID()}`;

    // The old client group reached a high cvr_version (the regression in #337
    // had the old group at order 724 while a forked group's per-group counter
    // restarted near 0). Persist that high-water mark.
    const STALE_ORDER = 724;
    await db()
      .insert(replicacheClientGroup)
      .values({ id: oldGroup, userId, cvrVersion: STALE_ORDER });

    // The forked client mints a new clientGroupID but its IndexedDB still holds
    // the old group's cookie. Replicache sends that stale cookie on the new
    // group's first pull. Before the fix this returned order 1 (prevVersion 0
    // + 1), regressing below 724 and wedging sync forever.
    const result = await handlePull(userId, {
      pullVersion: 1,
      clientGroupID: newGroup,
      cookie: { order: STALE_ORDER, clientGroupID: oldGroup },
    });

    assert.ok(!("forbidden" in result), "pull should be authorized for the owning user");
    assert.equal(result.cookie.clientGroupID, newGroup);
    assert.ok(
      result.cookie.order > STALE_ORDER,
      `forked cookie order ${result.cookie.order} must exceed the stale order ${STALE_ORDER}`,
    );
    // Canonical CVR pattern (replicache-cvr / dimension): the next order is
    // max(prevVersion, cookie.order) + 1. The fork's group is freshly created at
    // cvrVersion 0, so it advances to exactly the stale order + 1.
    assert.equal(result.cookie.order, STALE_ORDER + 1);
    // Mismatched cookie group ⇒ cold sync, so the patch leads with a clear.
    assert.equal(result.patch[0]?.op, "clear");

    // The new group's persisted cvr_version is the (monotonic) returned order.
    const [group] = await db()
      .select({ cvrVersion: replicacheClientGroup.cvrVersion })
      .from(replicacheClientGroup)
      .where(eq(replicacheClientGroup.id, newGroup));
    assert.equal(group?.cvrVersion, result.cookie.order);
  });

  test("repeated pulls on a single group keep order strictly non-decreasing", async () => {
    const userId = await seedUser();
    const group = `${ID_PREFIX}solo-${randomUUID()}`;

    const first = await handlePull(userId, {
      pullVersion: 1,
      clientGroupID: group,
      cookie: null,
    });
    assert.ok(!("forbidden" in first));

    // A second pull with the just-issued cookie and no underlying changes must
    // return the same order (Replicache's "cookie unchanged ⇒ no LMID changes"
    // invariant), never a lower one.
    const second = await handlePull(userId, {
      pullVersion: 1,
      clientGroupID: group,
      cookie: first.cookie,
    });
    assert.ok(!("forbidden" in second));
    assert.ok(second.cookie.order >= first.cookie.order);
  });
});
