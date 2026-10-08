import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { after, before, describe, test } from "node:test";

import { applyServerEnv } from "./support/server-env";
import { settleWithin, settlementMessage } from "./support/settle";

/**
 * A peer that accepts and then goes silent never closes, so `maxRetriesPerRequest`
 * never fires. Only `commandTimeout` ends the wait.
 * A separate file because `serverEnv()` memoizes one `REDIS_URL` per process.
 */

/** `commandTimeout` for `"command"` is 2s; this is that plus slack. */
const COMMAND_DEADLINE_MS = 4_000;

describe("redis connection kinds against a socket that accepts and never replies", () => {
  let redis: typeof import("../src/redis");
  let server: Server | undefined;
  const accepted: Socket[] = [];

  before(async () => {
    // Accept and do nothing: no reply, no FIN, no RST.
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

    // A late `REDIS_URL` is ignored, and the test would hit a real Redis.
    const { serverEnv } = await import("@alfred/env/server");
    assert.equal(serverEnv().REDIS_URL, zombieUrl); // drift-ok: asserts the fixture URL landed, does not gate a suite
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
    // MaxRetriesPerRequestError here would mean the peer closed, a different case.
    assert.match(settlementMessage(settlement), /Command timed out/);
  });
});
