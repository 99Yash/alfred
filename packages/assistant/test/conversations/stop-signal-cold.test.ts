import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { closeRedis, createRedisConnection } from "@alfred/db/redis";

import { isChatStopRequested, requestChatStop } from "../../src/conversations/stop-signal";
import { dbBackedSkip } from "../support/db-backed";

/**
 * The two halves of `stop-signal` want OPPOSITE cold-window outcomes, and this
 * file is the only place that says so against a real Redis.
 *
 * `enableOfflineQueue: false` rejects any command issued before a connection is
 * `ready`, so a `"fail-fast"` handle rejects the first command after its lazy
 * construction even against a healthy Redis. When BOTH verbs shared one such
 * handle, the first stop press of every process returned `false` and the HTTP
 * route turned that into a 503 (#127). The write half now takes `"command"`,
 * which waits for `ready` and still bounds the wait; the poll half keeps
 * `"fail-fast"` on purpose, because the stream loop awaits it and a bounded wait
 * there would stall streaming during an outage.
 *
 * ORDERING CONSTRAINT, and it is the point rather than an inconvenience: each
 * subtest must be the FIRST thing that touches its own connection, because the
 * cold window is one command wide. The two subtests use different connections,
 * so they do not interfere — but neither may be preceded by another call to the
 * same verb. That fragility IS the bug class this file exists to pin.
 *
 * A separate `"command"` connection reads and seeds the keys, so no assertion
 * below depends on the connection it is judging.
 */

const skip = dbBackedSkip("database+redis");

const stopKey = (runId: string) => `chat:stop:${runId}`;

after(async () => {
  await closeRedis();
});

describe("chat-stop signal on a cold process", { skip }, () => {
  test("the write half records the FIRST stop press of the process", async () => {
    const runId = `cold-probe-${randomUUID()}`;

    // First touch of the write connection: it is constructed and commanded in
    // the same tick, which is the shape `"fail-fast"` always rejects.
    const recorded = await requestChatStop(runId);

    // Firing control: the return value and the stored key are independent
    // observations. A cold rejection fails both, so this cannot pass by luck.
    const observer = createRedisConnection("command");
    observer.on("error", () => {});
    try {
      assert.equal(
        recorded,
        true,
        "requestChatStop returned false on a healthy Redis — the route turns that into a 503",
      );
      assert.equal(
        await observer.get(stopKey(runId)),
        "1",
        "requestChatStop reported success but wrote no flag",
      );
    } finally {
      await observer.del(stopKey(runId));
    }
  });

  test("the poll half misses the cold window on purpose, then self-heals", async () => {
    const runId = `cold-probe-${randomUUID()}`;

    // Seed through a connection this subtest is not judging, so the flag is
    // already present before the poll connection exists.
    const seeder = createRedisConnection("command");
    seeder.on("error", () => {});
    try {
      await seeder.set(stopKey(runId), "1", "EX", 60);

      // First touch of the POLL connection. `"fail-fast"` rejects it and the
      // caller reads that as "keep streaming".
      assert.equal(
        await isChatStopRequested(runId),
        false,
        'the poll half must reject its cold command — a "command" kind here would stall the stream loop during an outage',
      );

      // And the miss is the cold window ONLY. Once the connection is ready the
      // same read sees the flag that was there the whole time.
      const deadline = Date.now() + 5_000;
      let observed = false;
      while (!observed && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        observed = await isChatStopRequested(runId);
      }
      assert.equal(observed, true, "the poll half never recovered after its cold window");
    } finally {
      await seeder.del(stopKey(runId));
    }
  });
});
