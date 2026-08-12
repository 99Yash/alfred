import assert from "node:assert/strict";
import { createServer } from "node:net";
import { after, before, describe, test } from "node:test";

import type IORedis from "ioredis";

import { applyServerEnv } from "./support/server-env";
import { settleWithin, settlementMessage } from "./support/settle";

/**
 * The seam for issue "a Redis outage is a hang, not an error".
 *
 * Every assertion here runs against a port nothing is listening on, because a
 * mock that resolves or rejects on command is exactly what hid this defect: the
 * pre-fix `createRedisConnection` produced commands that NEVER settled, and a
 * mock has no way to be wrong in that direction. A real client against a closed
 * TCP port does.
 *
 * The bounds below are the kinds' own bounds plus slack for the connect
 * attempts, not tuning knobs — see the `CONNECTION_PROFILES` table in
 * `src/redis.ts`.
 */

/** Bound a `"command"` connection must settle inside: `commandTimeout` + slack. */
const COMMAND_DEADLINE_MS = 3_000;
/**
 * How long the `"queue"` control must stay pending. Strictly longer than
 * `COMMAND_DEADLINE_MS`, so "the harness sees a hang" and "the harness sees a
 * bounded rejection" cannot both be satisfied by the same observation.
 */
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
  /**
   * Kept at suite scope: the shutdown subtest needs a `"queue"` connection with
   * a command still pending on it, which is the shape that makes a graceful
   * `QUIT` inherit an unbounded wait.
   */
  let queueConn: IORedis | undefined;
  let queuePublish: Promise<unknown> | undefined;

  before(async () => {
    closedUrl = `redis://127.0.0.1:${await reserveClosedPort()}`;
    applyServerEnv(closedUrl);
    // Imported only now: the module itself is inert at load, but importing it
    // before `applyServerEnv` would be a standing invitation for someone to add
    // a module-scope `serverEnv()` read and silently memoize the wrong URL.
    redis = await import("../src/redis");

    // The override must be PROVEN to have landed. `serverEnv()` memoizes its
    // parse, so a test that set `REDIS_URL` too late would run against the real
    // Redis of the CI job or the developer's machine, and every assertion below
    // would pass while measuring nothing.
    const { serverEnv } = await import("@alfred/env/server");
    assert.equal(serverEnv().REDIS_URL, closedUrl);
  });

  after(async () => {
    // Belt and braces: the shutdown subtest is what normally drains these, but
    // a failure before it would otherwise leave sockets reconnecting forever.
    await redis.closeRedis();
  });

  test('"command" bounds publish, psubscribe and punsubscribe', async () => {
    const conn = redis.createRedisConnection("command");
    // Errors are emitted on the connection for every refused attempt; ioredis
    // throws on an unhandled `error` event.
    conn.on("error", () => {});

    const settlements = await Promise.all([
      settleWithin(conn.publish("policy-bust:u:probe", "1"), COMMAND_DEADLINE_MS),
      settleWithin(conn.psubscribe("policy-bust:u:*"), COMMAND_DEADLINE_MS),
      settleWithin(conn.punsubscribe("policy-bust:u:*"), COMMAND_DEADLINE_MS),
    ]);

    const names = ["publish", "psubscribe", "punsubscribe"];
    settlements.forEach((settlement, index) => {
      // "pending" is the pre-fix behavior and is called out by name: a bare
      // `assert.rejects` would report it as a timeout with no diagnosis.
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

    // This is the shape the issue was reported as: boot awaits `psubscribe` and
    // shutdown awaits `punsubscribe`, and both used to sit in the offline queue
    // forever. `"subscriber"` cannot carry a `commandTimeout` — one on a
    // subscribing connection kills the process, see
    // `redis-subscriber-reconnect.test.ts` — so `maxRetriesPerRequest` alone
    // does the work here, which it can because a refused connection closes.
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

    // `publish` is an ORDINARY command, and it hangs here. That is the point:
    // `"queue"` is unbounded for everything, not only for BullMQ's blocking
    // reads. BullMQ shares the instance it is handed as its non-blocking
    // client, so `queue.add()`'s own writes take this same unbounded path.
    //
    // If this ever settles, either BullMQ's carve-out was removed (its blocking
    // reads need it) or — worse — the closed port is not actually closed and
    // the subtest above proved nothing. Both are worth a red build.
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

    // The residual, pinned rather than hidden: shutdown does NOT settle the
    // command it walked away from. `disconnect()` flushes the queues from the
    // socket's `close` event, and a connection sitting in `reconnecting` has no
    // live socket to emit one — measured on ioredis 5.11.1. This is inside the
    // invariant, which exempts `"queue"`, and it is why `closeRedis` bounds
    // ITSELF instead of waiting for the command.
    const flushed = await settleWithin(queuePublish, FAIL_FAST_DEADLINE_MS);
    assert.equal(
      flushed.state,
      "pending",
      "a queue command settling at shutdown would be an improvement — update this assertion and closeRedis's docstring together",
    );
  });
});
