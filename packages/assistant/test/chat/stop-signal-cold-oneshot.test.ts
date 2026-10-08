import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { closeRedis, createRedisConnection } from "@alfred/db/redis";

import { isChatStopRequested } from "../../src/chat/stop-signal";
import { dbBackedSkip } from "../support/db-backed";

/**
 * `isChatStopRequested` reads the flag once before a tool batch, so it must wait out a cold handle (#127).
 * Its own file: it shares a handle with `requestChatStop`, and only the first command sees the cold window.
 */

const skip = dbBackedSkip("database+redis");

const stopKey = (runId: string) => `chat:stop:${runId}`;

after(async () => {
  await closeRedis();
});

describe("chat-stop one-shot read on a cold process", { skip }, () => {
  test("sees a flag that was already set, on its first command", async () => {
    const runId = `cold-probe-${randomUUID()}`;

    // Production case: the press lands, the process restarts, the resumed run reads cold.
    const seeder = createRedisConnection("command");
    seeder.on("error", () => {});

    try {
      await seeder.set(stopKey(runId), "1", "EX", 60);

      // First use of the handle: `"fail-fast"` would reject this.
      assert.equal(
        await isChatStopRequested(runId),
        true,
        "the one-shot read missed a flag that was already set — the tool batch would dispatch after the user asked to stop",
      );
    } finally {
      await seeder.del(stopKey(runId));
    }
  });
});
