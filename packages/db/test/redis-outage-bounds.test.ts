import assert from "node:assert/strict";
import { createServer } from "node:net";
import { after, before, describe, test } from "node:test";

import type IORedis from "ioredis";

import { applyServerEnv } from "./support/server-env";
import { settleWithin, settlementMessage } from "./support/settle";

/**
 * A Redis outage must be an error, not a hang. Tests use a real client on a closed
 * port, because a mock cannot show a command that never settles.
 * The deadlines are each kind's own bound plus slack (`CONNECTION_PROFILES` in `src/redis.ts`).
 */

/** Bound a `"command"` connection must settle inside: `commandTimeout` + slack. */
const COMMAND_DEADLINE_MS = 3_000;

/** Longer than `COMMAND_DEADLINE_MS`, so a hang and a bounded rejection look different. */
const QUEUE_PENDING_MS = 3_500;

/** `"fail-fast"` rejects synchronously in `sendCommand`; this is pure slack. */
const FAIL_FAST_DEADLINE_MS = 250;

/** `closeRedis()`'s own `QUIT_TIMEOUT_MS` plus slack. */
const SHUTDOWN_DEADLINE_MS = 2_500;

/** A port that was bound long enough to be sure it is free, then released. */
async function reserveClosedPort(): Promise<number> {
  const server = createServer();

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (address === null || typeof address === "string") {
        reject(new Error(`unexpected server address: ${String(address)}`));

        return;
      }

      resolve(address.port);
    });
  });

  await new Promise<void>((resolve) => server.close(() => resolve()));

  return port;
}

describe("redis connection kinds against an unreachable Redis", () => {
  let redis: typeof import("../src/redis");
  let closedUrl = "";
  /** Shared with the shutdown test, which needs a `"queue"` command still pending. */
  let queueConn: IORedis | undefined;
  let queuePublish: Promise<unknown> | undefined;

  before(async () => {
    closedUrl = `redis://127.0.0.1:${await reserveClosedPort()}`;
    applyServerEnv(closedUrl);
    // Import after `applyServerEnv`, so a future module-scope `serverEnv()` read gets the test URL.
    redis = await import("../src/redis");

    // `serverEnv()` memoizes; a late override would hit a real Redis and test nothing.
    const { serverEnv } = await import("@alfred/env/server");
    assert.equal(serverEnv().REDIS_URL, closedUrl); // drift-ok: asserts the fixture URL landed, does not gate a suite
  });

  after(async () => {
    // The shutdown test normally does this; an early failure would leave sockets reconnecting.
    await redis.closeRedis();
  });

  test('"command" bounds publish, get and set', async () => {
    const conn = redis.createRedisConnection("command");
    // ioredis throws on an unhandled `error` event.
    conn.on("error", () => {});

    // The verbs `"command"` callers use. `BoundedRedis` has no subscribe verbs
    // (`test/type/redis-kind-surface.type-test.ts`); those are tested on `"subscriber"` below.
    const settlements = await Promise.all([
      settleWithin(conn.publish("policy-bust:u:probe", "1"), COMMAND_DEADLINE_MS),
      settleWithin(conn.get("alfred:probe"), COMMAND_DEADLINE_MS),
      settleWithin(conn.set("alfred:probe", "1"), COMMAND_DEADLINE_MS),
    ]);

    const names = ["publish", "get", "set"];
    settlements.forEach((settlement, index) => {
      // Name "pending" explicitly; a bare `assert.rejects` would only report a timeout.
      assert.notEqual(
        settlement.state,
        "pending",
        `${names[index]} was still pending after ${COMMAND_DEADLINE_MS}ms — the offline queue is unbounded again`,
      );
      assert.equal(settlement.state, "rejected", `${names[index]} must reject, not resolve`);
      assert.match(
        settlementMessage(settlement),
        /max retries per request|Command timed out|Connection is closed/i,
        `${names[index]} rejected for an unexpected reason`,
      );
    });
  });

  test('"subscriber" bounds psubscribe and punsubscribe without a commandTimeout', async () => {
    const conn = redis.createRedisConnection("subscriber");
    conn.on("error", () => {});

    // Boot awaits `psubscribe` and shutdown awaits `punsubscribe`. With no `commandTimeout`
    // (see `redis-subscriber-reconnect.test.ts`), `maxRetriesPerRequest` alone bounds them.
    const settlements = await Promise.all([
      settleWithin(conn.psubscribe("policy-bust:u:*"), COMMAND_DEADLINE_MS),
      settleWithin(conn.punsubscribe("policy-bust:u:*"), COMMAND_DEADLINE_MS),
    ]);

    const names = ["psubscribe", "punsubscribe"];
    settlements.forEach((settlement, index) => {
      assert.notEqual(
        settlement.state,
        "pending",
        `${names[index]} was still pending after ${COMMAND_DEADLINE_MS}ms — boot and shutdown hang again`,
      );
      assert.equal(settlement.state, "rejected", `${names[index]} must reject, not resolve`);
      assert.match(
        settlementMessage(settlement),
        /max retries per request|Connection is closed/i,
        `${names[index]} rejected for an unexpected reason`,
      );
    });
  });

  test('"queue" is deliberately unbounded — the control that proves the harness sees a hang', async () => {
    queueConn = redis.createRedisConnection("queue");
    queueConn.on("error", () => {});

    // `"queue"` is unbounded for every command; BullMQ shares it for `queue.add()` too.
    // If this settles, the BullMQ setting was removed or the port is not really closed.
    queuePublish = queueConn.publish("policy-bust:u:probe", "1");
    const settlement = await settleWithin(queuePublish, QUEUE_PENDING_MS);

    assert.equal(
      settlement.state,
      "pending",
      `a "queue" command settled (${settlement.state}) — see the comment above; this subtest is what keeps the one before it honest`,
    );
  });

  test('"fail-fast" rejects without queueing', async () => {
    const conn = redis.createRedisConnection("fail-fast");
    conn.on("error", () => {});

    const settlement = await settleWithin(conn.get("alfred:probe"), FAIL_FAST_DEADLINE_MS);

    assert.equal(settlement.state, "rejected");
    assert.match(settlementMessage(settlement), /Stream isn't writeable/);
  });

  test("closeRedis bounds shutdown even with a command pending", async () => {
    assert.ok(queueConn, "the queue control subtest must have run first");
    assert.ok(queuePublish, "the queue control subtest must have run first");

    const settlement = await settleWithin(redis.closeRedis(), SHUTDOWN_DEADLINE_MS);

    assert.equal(
      settlement.state,
      "resolved",
      `closeRedis was ${settlement.state} after ${SHUTDOWN_DEADLINE_MS}ms — a graceful QUIT queued behind the pending command again`,
    );

    // Shutdown leaves the command pending: `disconnect()` flushes on socket `close`, and a
    // reconnecting client has no socket (ioredis 5.11.1). So `closeRedis` bounds itself.
    const flushed = await settleWithin(queuePublish, FAIL_FAST_DEADLINE_MS);
    assert.equal(
      flushed.state,
      "pending",
      "a queue command settling at shutdown would be an improvement — update this assertion and closeRedis's docstring together",
    );
  });
});
