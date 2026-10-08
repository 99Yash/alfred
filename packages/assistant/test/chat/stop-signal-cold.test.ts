import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { closeRedis, createRedisConnection } from "@alfred/db/redis";

import { pollChatStopFlag, requestChatStop } from "../../src/chat/stop-signal";
import { dbBackedSkip } from "../support/db-backed";

/**
 * The two `stop-signal` handles want opposite cold-window outcomes (#127).
 * A `"fail-fast"` handle rejects its first command, even on a healthy Redis.
 * `requestChatStop` must wait (`"command"`), or the first stop press of a process returns a 503.
 * `pollChatStopFlag` must not wait, or it stalls the stream loop during an outage.
 * Each subtest must be the first use of its handle. The one-shot read has its own file for that reason.
 */

const skip = dbBackedSkip("database+redis");

const stopKey = (runId: string) => `chat:stop:${runId}`;

after(async () => {
  await closeRedis();
});

describe("chat-stop signal on a cold process", { skip }, () => {
  test("the write half records the FIRST stop press of the process", async () => {
    const runId = `cold-probe-${randomUUID()}`;

    // First use of the write handle: `"fail-fast"` would reject this.
    const recorded = await requestChatStop(runId);

    // Check the stored key too, through a handle this test does not judge.
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

    // Seed through a handle this subtest does not judge.
    const seeder = createRedisConnection("command");
    seeder.on("error", () => {});

    try {
      await seeder.set(stopKey(runId), "1", "EX", 60);

      // First use of the poll handle: rejected, which reads as "keep streaming".
      assert.equal(
        await pollChatStopFlag(runId),
        false,
        'the poll half must reject its cold command — a "command" kind here would stall the stream loop during an outage',
      );

      // Once the handle is ready, the same read sees the flag.
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
