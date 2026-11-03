import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chatMemoryIdleJobId } from "@alfred/assistant/chat/idle-capture-queue";

describe("chatMemoryIdleJobId", () => {
  test("uses exact per-thread primary and tail job ids", () => {
    assert.equal(chatMemoryIdleJobId("thread_1", "primary"), "chat-mem-idle.thread_1");
    assert.equal(chatMemoryIdleJobId("thread_1", "tail"), "chat-mem-idle-tail.thread_1");
    assert.notEqual(
      chatMemoryIdleJobId("thread_1", "primary"),
      chatMemoryIdleJobId("thread_1", "tail"),
    );
  });
});
