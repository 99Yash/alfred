import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  applyStreamingToolEvent,
  type StreamingToolCall,
} from "../../src/lib/chat/use-chat-stream";

const baseEvent = {
  runId: "run_1",
  threadId: "thread_1",
  messageId: "message_1",
  toolCallId: "tool_1",
  toolName: "gmail.search",
  segmentIndex: 0,
} as const;

describe("applyStreamingToolEvent", () => {
  test("retracts an optimistic card for a non-execution result", () => {
    const tools = new Map<string, StreamingToolCall>();
    applyStreamingToolEvent(tools, { ...baseEvent, status: "started" });
    assert.equal(tools.size, 1);

    applyStreamingToolEvent(tools, {
      ...baseEvent,
      status: "failed",
      nonExecution: true,
    });
    assert.equal(tools.size, 0);
  });

  test("a retraction without an optimistic card is a no-op", () => {
    const tools = new Map<string, StreamingToolCall>();
    applyStreamingToolEvent(tools, {
      ...baseEvent,
      status: "failed",
      nonExecution: true,
    });
    assert.equal(tools.size, 0);
  });
});
