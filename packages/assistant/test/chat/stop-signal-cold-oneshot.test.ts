import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { closeRedis, createRedisConnection } from "@alfred/db/redis";

import { isChatStopRequested } from "../../src/chat/stop-signal";
import { dbBackedSkip } from "../support/db-backed";

/**
 * The ONE-SHOT read of the chat-stop flag, on the first command of the process.
 *
 * `isChatStopRequested` has one production caller: the dispatch-tools step
 * (`chat-turn.ts`), which reads the flag once before it dispatches a pending
 * tool batch and never reads it again. A `false` it reads by mistake sends every
 * external effect in that batch after the user asked to stop, and the Redis key
 * is the flag's only store, so this reader must WAIT for a handshaking
 * connection rather than be rejected by it (#127).
 *
 * WHY THIS IS ITS OWN FILE. The cold window is one command wide, so only one
 * subtest per process can be the first command on a given handle, and
 * `node:test` gives each FILE its own process. `requestChatStop` shares this
 * bounded handle and is pinned in `stop-signal-cold.test.ts`; whichever of the
 * two ran first would warm the handle for the other. Neither file may import the
 * other's verb.
 *
 * The seeding connection is a separate `"command"` handle, so the assertion does
 * not depend on the connection it judges.
 */

const skip = dbBackedSkip("database+redis");

const stopKey = (runId: string) => `chat:stop:${runId}`;

after(async () => {
  await closeRedis();
});

describe("chat-stop one-shot read on a cold process", { skip }, () => {
  test("sees a flag that was already set, on its first command", async () => {
    const runId = `cold-probe-${randomUUID()}`;

    // Seed through a connection this subtest is not judging, so the flag is
    // already present before the bounded handle exists. This is the sequence
    // that matters in production: the press lands, the process restarts, and the
    // resumed run reads the flag with a connection that has never been used.
    const seeder = createRedisConnection("command");
    seeder.on("error", () => {});
    try {
      await seeder.set(stopKey(runId), "1", "EX", 60);

      // First touch of the BOUNDED handle: constructed and commanded in the same
      // tick, which is the shape a `"fail-fast"` handle always rejects.
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
