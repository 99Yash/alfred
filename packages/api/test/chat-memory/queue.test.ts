import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chatMemoryIdleJobId, chatMemoryIdleTailJobId } from "../../src/modules/chat-memory/queue";

describe("chatMemoryIdleJobId", () => {
  test("uses exact per-thread primary and tail job ids", () => {
    assert.equal(chatMemoryIdleJobId("thread_1"), "chat-mem-idle.thread_1");
    assert.equal(chatMemoryIdleTailJobId("thread_1"), "chat-mem-idle-tail.thread_1");
    assert.notEqual(chatMemoryIdleJobId("thread_1"), chatMemoryIdleTailJobId("thread_1"));
  });
});
