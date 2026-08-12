import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { after, before, describe, test } from "node:test";

import { applyServerEnv } from "./support/server-env";
import { settleWithin, settlementMessage } from "./support/settle";

/**
 * The half of a Redis outage that `maxRetriesPerRequest` cannot reach, and
 * therefore the only thing that makes `"command"`'s `commandTimeout` more than
 * decoration.
 *
 * `maxRetriesPerRequest` flushes the queues from the connection's `close`
 * handler. A peer that completes the TCP handshake and then goes silent — a
 * hung Redis, a stalled proxy, a network path that blackholes the reply —
 * never closes, so that option never fires. The socket stays writable, the
 * command is written rather than queued, and nothing but `commandTimeout` can
 * end the wait.
 *
 * This is a separate FILE, not a subtest of `redis-outage-bounds.test.ts`,
 * because `serverEnv()` memoizes on its first call: one process can point
 * `@alfred/db/redis` at exactly one `REDIS_URL`, and the node test runner gives
 * each file its own process.
 */

/** `commandTimeout` for `"command"` is 2s; this is that plus slack. */
const COMMAND_DEADLINE_MS = 4_000;

describe("redis connection kinds against a socket that accepts and never replies", () => {
  let redis: typeof import("../src/redis");
  let server: Server | undefined;
  const accepted: Socket[] = [];

  before(async () => {
    // Accept the connection and do nothing else — no reply, no FIN, no RST.
    const zombie = createServer((socket) => accepted.push(socket));
    server = zombie;
    const port = await new Promise<number>((resolve, reject) => {
      zombie.once("error", reject);
      zombie.listen(0, "127.0.0.1", () => {
        const address = zombie.address();
        if (address === null || typeof address === "string") {
          reject(new Error(`unexpected server address: ${String(address)}`));
          return;
        }
        resolve(address.port);
      });
    });

    const zombieUrl = `redis://127.0.0.1:${port}`;
    applyServerEnv(zombieUrl);
    redis = await import("../src/redis");

    // Proven, not assumed: a `REDIS_URL` set after the first `serverEnv()` call
    // is silently ignored, and this file would then talk to a real Redis and
    // measure nothing.
    const { serverEnv } = await import("@alfred/env/server");
    assert.equal(serverEnv().REDIS_URL, zombieUrl);
  });

  after(async () => {
    await redis.closeRedis();
    for (const socket of accepted) socket.destroy();
    accepted.length = 0;
    const listening = server;
    if (listening) await new Promise<void>((resolve) => listening.close(() => resolve()));
  });

  test('"command" bounds a command on a live-but-silent connection', async () => {
    const conn = redis.createRedisConnection("command");
    conn.on("error", () => {});

    const settlement = await settleWithin(conn.ping(), COMMAND_DEADLINE_MS);

    assert.notEqual(
      settlement.state,
      "pending",
      `a command on a silent open socket was still pending after ${COMMAND_DEADLINE_MS}ms — commandTimeout is the only option that bounds this shape, so removing it removes this guarantee`,
    );
    assert.equal(settlement.state, "rejected");
    // Named exactly: a rejection carrying MaxRetriesPerRequestError here would
    // mean the peer closed after all, and the subtest would be measuring the
    // other failure shape.
    assert.match(settlementMessage(settlement), /Command timed out/);
  });
});
