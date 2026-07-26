import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  applyStreamingToolEvent,
  subAgentEventAddressesStream,
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

    // A replayed terminal frame (SSE reconnect) must not push the clock forward,
    // or the duration chip would grow every time the stream reconnects.
    applyStreamingToolEvent(tools, { ...baseEvent, status: "succeeded" }, 9_000);
    assert.equal(tools.get("tool_1")?.endedTs, 2_500);
  });

  test("a replayed started event cannot un-finish a landed card", () => {
    // `dispatchBatch` re-dispatches the whole batch on resume/reclaim and
    // republishes each `started`, and SSE frames are not ordered — so a
    // `started` after a terminal is expected traffic, not a bug. Absorbing it
    // is what keeps a finished step from flipping back to a spinner.
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
    // The absorbing guard is scoped to `started`: a terminal frame must keep
    // its authority, or a reissued call's retraction would be dropped.
    const tools = new Map<string, StreamingToolCall>();
    applyStreamingToolEvent(tools, { ...baseEvent, status: "succeeded" }, 1_000);
    applyStreamingToolEvent(tools, { ...baseEvent, status: "failed", nonExecution: true }, 2_000);
    assert.equal(tools.size, 0);
  });

  test("a call seen first at its terminal event still gets a bounded duration", () => {
    // The optimistic `started` event is suppressed for a tool that is not yet on
    // the active surface (`shouldPublishToolStarted`), so the terminal event can
    // legitimately be the first one we see.
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
    // Cancelling a run does not cascade to its children and a spawn need never
    // be awaited, so a child outlives its parent turn. If a late child event
    // could mount a stream ref, the sequence "stop turn 1, send turn 2, child
    // publishes" would replace turn 2's ref: its deltaSeq resets to 0, its
    // segments empty, and the bubble blanks mid-answer.
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
