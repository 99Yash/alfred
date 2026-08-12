import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, describe, test } from "node:test";

import { applyServerEnv } from "./support/server-env";
import { settleWithin, settlementMessage } from "./support/settle";

/**
 * Why there are THREE connection kinds and not two, pinned against a real Redis.
 *
 * `"fail-fast"` looks like it could serve every non-BullMQ caller — it already
 * bounds an outage, and it has been in this module the whole time. It cannot,
 * and the reason is not visible in an outage test: `enableOfflineQueue: false`
 * rejects whenever the connection is not writable, and writable requires
 * `status === "ready"`. A command issued in the same tick as the constructor is
 * therefore ALWAYS rejected, even by a perfectly healthy Redis.
 *
 * Every ordinary-command caller in this repo is a lazy `??=` getter that
 * constructs and immediately commands, so collapsing `"command"` into
 * `"fail-fast"` would break the first publish, the first OAuth-state write and
 * the boot-time `psubscribe` of every process — against a healthy Redis. This
 * file is the test that reddens when someone tries.
 *
 * Needs a reachable Redis. The `db-tests` CI job supplies one; locally,
 * `docker compose up redis` does.
 */

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379";
const DEADLINE_MS = 5_000;

describe("redis connection kinds against a healthy Redis", () => {
  let redis: typeof import("../src/redis");

  before(async () => {
    applyServerEnv(REDIS_URL);
    redis = await import("../src/redis");

    // Fail loudly rather than skipping: a skipped subtest here would remove the
    // only evidence that `"command"` and `"fail-fast"` differ at all.
    const probe = redis.createRedisConnection("queue");
    try {
      assert.equal(await probe.ping(), "PONG", `no Redis at ${REDIS_URL}`);
    } finally {
      await redis.closeRedis();
    }
  });

  after(async () => {
    await redis.closeRedis();
  });

  test('"command" runs a command issued in the same tick as the constructor', async () => {
    const conn = redis.createRedisConnection("command");
    conn.on("error", () => {});

    // No `await` between construction and the command: this is the shape every
    // lazy getter in the repo has.
    const settlement = await settleWithin(conn.ping(), DEADLINE_MS);

    assert.equal(
      settlement.state,
      "resolved",
      `a cold "command" ping was ${settlement.state} (${settlementMessage(settlement)}) — the offline queue is what carries it to a ready connection`,
    );
    assert.equal(settlement.value, "PONG");
  });

  test('"fail-fast" rejects the same command, which is why it cannot replace "command"', async () => {
    const conn = redis.createRedisConnection("fail-fast");
    conn.on("error", () => {});

    const settlement = await settleWithin(conn.ping(), DEADLINE_MS);

    assert.equal(settlement.state, "rejected");
    assert.match(settlementMessage(settlement), /Stream isn't writeable/);

    // And it recovers once ready, so the rejection is about the cold window
    // only — the caller falling back to its source of truth is not permanent.
    // The wait is load-bearing: `"fail-fast"` rejects for as long as the status
    // is anything other than `ready`, connecting included.
    if (conn.status !== "ready") await once(conn, "ready");
    assert.equal(await conn.ping(), "PONG");
  });
});
