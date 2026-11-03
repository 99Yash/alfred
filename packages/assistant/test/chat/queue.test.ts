import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chatMemoryQueue } from "@alfred/assistant/chat/idle-capture-queue";

describe("chat-memory.extract job id", () => {
  test("uses exact per-thread primary and tail job ids", () => {
    const idOf = (slot: "primary" | "tail") =>
      chatMemoryQueue.jobId("chat-memory.extract", { threadId: "thread_1", slot });

    assert.equal(idOf("primary"), "chat-mem-idle.thread_1");
    assert.equal(idOf("tail"), "chat-mem-idle-tail.thread_1");
    assert.notEqual(idOf("primary"), idOf("tail"));
  });
});
