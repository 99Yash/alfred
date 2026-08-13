import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { getStringPath } from "@alfred/contracts";
import { closeRedis } from "@alfred/db/redis";

import { dbBackedSkip } from "./support/db-backed";
import { applyServerEnvFixtures } from "./support/server-env";

/**
 * `/ready` against a REAL Redis, on the FIRST request the process ever makes.
 *
 * The endpoint used to build a `"fail-fast"` connection per request and ping it
 * in the same tick. `enableOfflineQueue: false` rejects every command issued
 * before the connection reaches `ready`, and a connection commanded in the tick
 * it was constructed is never ready — so `checks.redis` read `"error"` on every
 * request against a perfectly healthy Redis, and `/ready` always answered 503
 * (#127).
 *
 * The mock is what hid this. `root-app.test.ts` replaces `IORedis.prototype.ping`
 * for all three of its `/ready` arms, so no arm can observe a cold connection.
 * This file therefore mocks NOTHING and dials the real service.
 *
 * ONE REQUEST, and it must be the first. `node:test` gives each file its own
 * process, so the module registry here is cold and the request below constructs
 * the handle. A second request would find a ready connection and pass either
 * way, which is why this file holds exactly one arm.
 *
 * Asserts on `checks.redis` alone, never on `ok`: the `db` check needs a
 * migrated database, and this arm is about Redis.
 */

// Read the guard BEFORE the fixtures. `applyServerEnvFixtures` supplies default
// DATABASE_URL and REDIS_URL values, so the opposite order would satisfy the
// guard on a machine that runs neither service and fail instead of skipping.
const skip = dbBackedSkip("database+redis");

applyServerEnvFixtures();

const { app } = await import("@alfred/http");

after(async () => {
  await closeRedis();
});

describe("/ready on a cold process", { skip }, () => {
  test("reports Redis healthy on the first request, with no ioredis mock", async () => {
    const response = await app.handle(new Request("http://localhost/ready"));
    const body: unknown = await response.json();

    assert.equal(
      getStringPath(body, "checks", "redis"),
      "ok",
      'the first /ready request of a process must reach Redis — "error" here means the probe connection rejects its own cold window',
    );
  });
});
