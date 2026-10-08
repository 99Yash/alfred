import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  applyStreamingToolEvent,
  subAgentEventAddressesStream,
  type StreamingToolCall,
} from "../../src/lib/chat/chat-stream-state";

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
    applyStreamingToolEvent(tools, { ...baseEvent, status: "started" }, 1_000);
    assert.equal(tools.size, 1);

    applyStreamingToolEvent(tools, { ...baseEvent, status: "failed", nonExecution: true }, 2_000);
    assert.equal(tools.size, 0);
  });

  test("a retraction without an optimistic card is a no-op", () => {
    const tools = new Map<string, StreamingToolCall>();
    applyStreamingToolEvent(tools, { ...baseEvent, status: "failed", nonExecution: true }, 1_000);
    assert.equal(tools.size, 0);
  });

  test("stamps the start once and freezes the clock at the terminal event", () => {
    const tools = new Map<string, StreamingToolCall>();
    applyStreamingToolEvent(tools, { ...baseEvent, status: "started" }, 1_000);
    assert.deepEqual(
      { startedTs: tools.get("tool_1")?.startedTs, endedTs: tools.get("tool_1")?.endedTs },
      { startedTs: 1_000, endedTs: null },
    );

    applyStreamingToolEvent(tools, { ...baseEvent, status: "succeeded" }, 2_500);
    assert.deepEqual(
      { startedTs: tools.get("tool_1")?.startedTs, endedTs: tools.get("tool_1")?.endedTs },
      { startedTs: 1_000, endedTs: 2_500 },
    );

    // A replayed terminal frame must not move the clock, or the duration grows on each reconnect.
    applyStreamingToolEvent(tools, { ...baseEvent, status: "succeeded" }, 9_000);
    assert.equal(tools.get("tool_1")?.endedTs, 2_500);
  });

  test("a replayed started event cannot un-finish a landed card", () => {
    // Resume republishes `started` and SSE frames are not ordered, so a late `started` is normal.
    const tools = new Map<string, StreamingToolCall>();
    applyStreamingToolEvent(tools, { ...baseEvent, status: "started" }, 1_000);
    applyStreamingToolEvent(
      tools,
      { ...baseEvent, status: "succeeded", resultPreview: "3 messages" },
      2_000,
    );

    applyStreamingToolEvent(tools, { ...baseEvent, status: "started" }, 8_000);
    assert.deepEqual(
      {
        status: tools.get("tool_1")?.status,
        endedTs: tools.get("tool_1")?.endedTs,
        resultPreview: tools.get("tool_1")?.resultPreview,
      },
      { status: "succeeded", endedTs: 2_000, resultPreview: "3 messages" },
    );
  });

  test("a bounce still retracts a landed card", () => {
    // The absorbing guard applies to `started` only, or a reissued call's retraction would be lost.
    const tools = new Map<string, StreamingToolCall>();
    applyStreamingToolEvent(tools, { ...baseEvent, status: "succeeded" }, 1_000);
    applyStreamingToolEvent(tools, { ...baseEvent, status: "failed", nonExecution: true }, 2_000);
    assert.equal(tools.size, 0);
  });

  test("a call seen first at its terminal event still gets a bounded duration", () => {
    // `shouldPublishToolStarted` can suppress `started`, so the terminal event can come first.
    const tools = new Map<string, StreamingToolCall>();
    applyStreamingToolEvent(tools, { ...baseEvent, status: "succeeded" }, 4_000);
    assert.deepEqual(
      { startedTs: tools.get("tool_1")?.startedTs, endedTs: tools.get("tool_1")?.endedTs },
      { startedTs: 4_000, endedTs: 4_000 },
    );
  });
});

describe("subAgentEventAddressesStream", () => {
  const turn = { messageId: "message_1", runId: "run_1", stopped: false };

  test("addresses the turn it names", () => {
    assert.equal(
      subAgentEventAddressesStream(turn, { messageId: "message_1", runId: "run_1" }),
      true,
    );
  });

  test("a child event never mounts a turn of its own", () => {
    // A child can outlive its parent turn. If its late event mounted a ref, it would replace
    // the next turn's ref and blank that bubble mid-answer.
    assert.equal(
      subAgentEventAddressesStream(null, { messageId: "message_1", runId: "run_1" }),
      false,
    );
  });

  test("a stale child event does not address the turn now on screen", () => {
    assert.equal(
      subAgentEventAddressesStream(turn, { messageId: "message_2", runId: "run_2" }),
      false,
    );
    // Same message, new run (a retry) is still a different turn.
    assert.equal(
      subAgentEventAddressesStream(turn, { messageId: "message_1", runId: "run_2" }),
      false,
    );
  });

  test("a stopped turn takes no further child steps", () => {
    assert.equal(
      subAgentEventAddressesStream(
        { ...turn, stopped: true },
        { messageId: "message_1", runId: "run_1" },
      ),
      false,
    );
  });
});
