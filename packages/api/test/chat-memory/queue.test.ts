import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chatMemoryIdleJobId } from "../../src/modules/chat-memory/queue";

describe("chatMemoryIdleJobId", () => {
  test("anchors the debounce job to the completed message that triggered capture", () => {
    assert.equal(chatMemoryIdleJobId("thread_1", "msg_a"), "chat-mem-idle.thread_1.msg_a");
    assert.notEqual(
      chatMemoryIdleJobId("thread_1", "msg_a"),
      chatMemoryIdleJobId("thread_1", "msg_b"),
    );
  });
});
