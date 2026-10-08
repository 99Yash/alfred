import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { closeRedis, createRedisConnection } from "@alfred/db/redis";
import { replicacheClientGroup, user } from "@alfred/db/schemas";
import { eq, inArray } from "drizzle-orm";

import { getCVRStore } from "../../src/sync/cvr";
import { handlePull } from "../../src/sync/pull";
import { dbBackedSkip } from "../support/db-backed";

const SERVER_ENV_FIXTURES = {
  BETTER_AUTH_SECRET: "test better auth secret with length",
  // #453: `serverEnv()` requires a 32-byte credential KEK in every environment.
  OAUTH_CREDENTIAL_KEK: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
  BETTER_AUTH_URL: "http://localhost:3001",
  ALFRED_ALLOWED_EMAIL: "test@example.com",
  RESEND_API_KEY: "test-resend",
  RESEND_FROM_EMAIL: "Alfred <noreply@example.com>",
  ANTHROPIC_API_KEY: "test-anthropic",
  GOOGLE_GENERATIVE_AI_API_KEY: "test-google-ai",
  GOOGLE_OAUTH_CLIENT_ID: "test-google-client",
  GOOGLE_OAUTH_CLIENT_SECRET: "test-google-secret",
  GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3001/api/auth/callback/google",
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "test-app",
  GITHUB_APP_CLIENT_ID: "test-github-client",
  GITHUB_APP_CLIENT_SECRET: "test-github-secret",
  GITHUB_APP_PRIVATE_KEY: "test-private-key",
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
  GITHUB_APP_REDIRECT_URI: "http://localhost:3001/api/integrations/github/callback",
} satisfies Record<string, string>;

function seedServerEnvForReplicacheTests(): void {
  for (const [key, value] of Object.entries(SERVER_ENV_FIXTURES)) {
    process.env[key] ??= value;
  }
}

// `serverEnv()` memoizes, so seed at module scope. No service URL here, so the guard still skips.
seedServerEnvForReplicacheTests();

const SKIP = dbBackedSkip("database+redis");

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
      // Client groups cascade from user.
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }

    await closeRedis();
    await closeConnections();
  });

  test("a forked client group's first pull cookie cannot regress below the stale cookie", async () => {
    const userId = await seedUser();
    const oldGroup = `${ID_PREFIX}old-${randomUUID()}`;
    const newGroup = `${ID_PREFIX}new-${randomUUID()}`;

    // Regression #337: the old group was at order 724; the fork's counter restarted near 0.
    const STALE_ORDER = 724;
    await db()
      .insert(replicacheClientGroup)
      .values({ id: oldGroup, userId, cvrVersion: STALE_ORDER });

    // The fork has a new clientGroupID but sends the old group's cookie.
    // The bug returned order 1 here and wedged sync.
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
    // Next order is max(prevVersion, cookie.order) + 1.
    assert.equal(result.cookie.order, STALE_ORDER + 1);
    // A cookie from another group means a cold sync, so the patch starts with a clear.
    assert.equal(result.patch[0]?.op, "clear");

    // The persisted cvr_version equals the returned order.
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

    // Same cookie and no changes must return the same order, never a lower one.
    const second = await handlePull(userId, {
      pullVersion: 1,
      clientGroupID: group,
      cookie: first.cookie,
    });

    assert.ok(!("forbidden" in second));
    assert.ok(second.cookie.order >= first.cookie.order);
  });

  test("an out-of-range cookie order falls back to a safe cold sync", async () => {
    const userId = await seedUser();
    const group = `${ID_PREFIX}oversized-${randomUUID()}`;

    const result = await handlePull(userId, {
      pullVersion: 1,
      clientGroupID: group,
      cookie: { order: Number.MAX_SAFE_INTEGER, clientGroupID: group },
    });

    assert.ok(!("forbidden" in result));
    assert.equal(result.patch[0]?.op, "clear");
    assert.equal(result.cookie.clientGroupID, group);
    assert.equal(result.cookie.order, 1);

    const [storedGroup] = await db()
      .select({ cvrVersion: replicacheClientGroup.cvrVersion })
      .from(replicacheClientGroup)
      .where(eq(replicacheClientGroup.id, group));

    assert.equal(storedGroup?.cvrVersion, result.cookie.order);
  });

  test("a legacy uppercase CVR snapshot becomes a cold sync", async () => {
    const userId = await seedUser();
    const group = `${ID_PREFIX}legacy-${randomUUID()}`;
    const order = 7;
    await db().insert(replicacheClientGroup).values({ id: group, userId, cvrVersion: order });

    const redis = createRedisConnection("command");
    await redis.set(
      `cvr:${group}:${order}`,
      JSON.stringify({ entities: { TODO: { "gone-todo": { v: 1 } } }, clients: {} }),
      "EX",
      60,
    );

    const result = await handlePull(userId, {
      pullVersion: 1,
      clientGroupID: group,
      cookie: { order, clientGroupID: group },
    });

    assert.ok(!("forbidden" in result));
    assert.equal(result.patch[0]?.op, "clear");
    assert.equal(result.cookie.order, order + 1);
  });

  test("a current lowercase CVR snapshot keeps delta deletes", async () => {
    const userId = await seedUser();
    const group = `${ID_PREFIX}current-${randomUUID()}`;
    const order = 11;
    await db().insert(replicacheClientGroup).values({ id: group, userId, cvrVersion: order });

    const redis = createRedisConnection("command");
    await redis.set(
      `cvr:${group}:${order}`,
      JSON.stringify({ entities: { todo: { "gone-todo": { v: 1 } } }, clients: {} }),
      "EX",
      60,
    );

    const result = await handlePull(userId, {
      pullVersion: 1,
      clientGroupID: group,
      cookie: { order, clientGroupID: group },
    });

    assert.ok(!("forbidden" in result));
    assert.equal(
      result.patch.some((operation) => operation.op === "clear"),
      false,
    );
    assert.deepEqual(result.patch, [{ op: "del", key: "todo/gone-todo" }]);
  });

  test("CVRStore reads a snapshot written by its current schema", async () => {
    const group = `${ID_PREFIX}roundtrip-${randomUUID()}`;

    const snapshot = {
      entities: { todo: { "todo-1": { v: 2 } } },
      clients: { "client-1": 4 },
    } as const;

    const store = getCVRStore();

    await store.put(group, 3, snapshot);

    assert.deepEqual(await store.get(group, 3), snapshot);
  });
});
