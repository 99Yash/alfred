import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { closeRedis, createRedisConnection } from "@alfred/db/redis";

import { pollChatStopFlag, requestChatStop } from "../../src/chat/stop-signal";
import { dbBackedSkip } from "../support/db-backed";

/**
 * The two handles of `stop-signal` want OPPOSITE cold-window outcomes, and this
 * file is the only place that says so against a real Redis.
 *
 * `enableOfflineQueue: false` rejects any command issued before a connection is
 * `ready`, so a `"fail-fast"` handle rejects the first command after its lazy
 * construction even against a healthy Redis. When every caller shared ONE such
 * handle, a stop press returned `false` — and the HTTP route turned that into a
 * 503 (#127) — whenever the press was the first command on that handle. That
 * was NARROWER than "every process", because `apps/server` runs the HTTP server
 * and the assistant workers on one module instance, so a turn that streamed for
 * more than 400 ms had already warmed the shared handle with its own poll. The
 * press had to arrive on a still-queued run, or inside the first poll interval.
 *
 * The split makes the write's case STRONGER, not weaker: `requestChatStop` now
 * owns a handle no poll can warm, so the first press of a process is ALWAYS the
 * cold command on it. That is why `"command"` is mandatory here rather than
 * merely better. `pollChatStopFlag` keeps `"fail-fast"` on purpose, because the
 * stream loop awaits it and a bounded wait there would stall streaming during an
 * outage.
 *
 * The bounded handle's OTHER caller, the one-shot read at `chat-turn.ts`, is
 * pinned in `stop-signal-cold-oneshot.test.ts`. It needs its own file: the cold
 * window is one command wide, so only one subtest per process can be the first
 * command on a given handle.
 *
 * ORDERING CONSTRAINT, and it is the point rather than an inconvenience: each
 * subtest must be the FIRST thing that touches its own connection. The two
 * subtests use different connections, so they do not interfere — but neither may
 * be preceded by another call that shares its handle. That fragility IS the bug
 * class this file exists to pin.
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
        await pollChatStopFlag(runId),
        false,
        'the poll half must reject its cold command — a "command" kind here would stall the stream loop during an outage',
      );

      // And the miss is the cold window ONLY. Once the connection is ready the
      // same read sees the flag that was there the whole time.
      const deadline = Date.now() + 5_000;
      let observed = false;
      while (!observed && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        observed = await pollChatStopFlag(runId);
      }
      assert.equal(observed, true, "the poll half never recovered after its cold window");
    } finally {
      await seeder.del(stopKey(runId));
    }
  });
});
