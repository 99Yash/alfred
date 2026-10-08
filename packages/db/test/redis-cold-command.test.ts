import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, describe, test } from "node:test";

import { applyServerEnv } from "./support/server-env";
import { settleWithin, settlementMessage } from "./support/settle";

/**
 * Why `"fail-fast"` cannot replace `"command"`. `enableOfflineQueue: false` rejects
 * until `status === "ready"`, so a command sent in the constructor's tick always fails,
 * even on a healthy Redis. Lazy `??=` getters do exactly that.
 * Needs a real Redis (`docker compose up redis`; the `db-tests` CI job has one).
 */

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379"; // drift-ok: this tree FAILS LOUDLY on an absent Redis instead of skipping

const DEADLINE_MS = 5_000;

describe("redis connection kinds against a healthy Redis", () => {
  let redis: typeof import("../src/redis");

  before(async () => {
    applyServerEnv(REDIS_URL);
    redis = await import("../src/redis");

    // Fail, do not skip, when Redis is missing. Probe with `"command"`: a `"queue"`
    // ping would hang, and a `"fail-fast"` ping fails while cold.
    const probe = redis.createRedisConnection("command");
    probe.on("error", () => {});

    try {
      const settlement = await settleWithin(probe.ping(), DEADLINE_MS);
      assert.equal(
        settlement.state,
        "resolved",
        `no Redis at ${REDIS_URL} — the probe was ${settlement.state} (${settlementMessage(settlement)}); start one with \`docker compose up redis\``,
      );
      assert.equal(settlement.value, "PONG");
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

    // No `await` after construction, like a lazy getter.
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

    // It works once `ready`, so only the cold window fails.
    if (conn.status !== "ready") await once(conn, "ready");
    assert.equal(await conn.ping(), "PONG");
  });
});
