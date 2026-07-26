import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CHAT_TOOL_CALL_ID_MAX,
  CHAT_TOOL_NAME_MAX,
  chatToolSchema,
} from "@alfred/contracts/events";
import type { TerminalDispatchResult } from "../../src/modules/dispatch";
import {
  readSubAgentMetadata,
  type SubAgentMetadata,
} from "../../src/modules/agent/sub-agent-metadata";
import {
  NESTED_SEGMENT_INDEX,
  subAgentToolCardTarget,
  toolCardStarted,
  toolCardTerminal,
} from "../../src/modules/agent/workflows/tool-card-events";
import { toolEventOutcome } from "../../src/modules/agent/workflows/tool-event-outcome";

describe("sub-agent chat origin", () => {
  const base = {
    kind: "sub_agent",
    parentRunId: "run_parent",
    subId: "sub_a",
    parentToolCallId: "call_1",
  } as const;

  test("carries the parent chat turn so the child can stream its trail there", () => {
    const meta = readSubAgentMetadata({
      subAgent: { ...base, chat: { threadId: "thread_1", messageId: "msg_1" } },
    });
    assert.deepEqual(meta?.chat, { threadId: "thread_1", messageId: "msg_1" });
  });

  test("a background parent has no chat origin, and that is not an error", () => {
    // A cron brief or any non-chat boss run spawns children with no thread to
    // publish into; they must still parse, and simply run without a trail.
    const meta = readSubAgentMetadata({ subAgent: base });
    assert.equal(meta?.parentRunId, "run_parent");
    assert.equal(meta?.chat, undefined);
  });

  test("a partial chat origin is rejected rather than half-published", () => {
    // Publishing with a threadId but no messageId would address a turn the
    // client cannot key, so the whole metadata fails to parse instead.
    const meta = readSubAgentMetadata({ subAgent: { ...base, chat: { threadId: "thread_1" } } });
    assert.equal(meta, null);
  });
});

describe("sub-agent tool cards", () => {
  const child: SubAgentMetadata = {
    kind: "sub_agent",
    parentRunId: "run_parent",
    subId: "sub_a",
    parentToolCallId: "call_spawn",
    chat: { threadId: "thread_1", messageId: "msg_1" },
  };
  const target = subAgentToolCardTarget(child, "run_child")!;

  test("the event is addressed to the PARENT run, never the child", () => {
    // The client keys its in-flight turn on (messageId, runId). A child runId
    // here would read as a new turn and blank the bubble mid-stream, so this is
    // the one field worth pinning.
    assert.equal(target.runId, "run_parent");
    assert.notEqual(target.runId, "run_child");
    assert.deepEqual(target.subAgent, {
      parentToolCallId: "call_spawn",
      subId: "sub_a",
      childRunId: "run_child",
    });
  });

  test("no target for the boss, or for a child of a background parent", () => {
    assert.equal(subAgentToolCardTarget(null, "run_child"), null);
    const { chat: _chat, ...noChat } = child;
    assert.equal(subAgentToolCardTarget(noChat, "run_child"), null);
  });

  test("both payloads satisfy the wire schema and keep parent addressing", () => {
    const started = toolCardStarted(
      target,
      {
        toolCallId: "call_1",
        toolName: "github.search",
        input: { q: "repo:99Yash/alfred" },
      },
      NESTED_SEGMENT_INDEX,
    );
    const terminal = toolCardTerminal(
      target,
      { toolCallId: "call_1", toolName: "github.search" },
      toolEventOutcome("github.search", {
        kind: "executed",
        toolResult: { items: [] },
      } as unknown as TerminalDispatchResult),
      { segmentIndex: NESTED_SEGMENT_INDEX },
    );

    for (const payload of [started, terminal]) {
      // publishEvent throws on a payload the schema rejects, which would fail
      // the sub-agent's dispatch step — so validate the exact shape we publish.
      assert.equal(chatToolSchema.safeParse(payload).success, true);
      assert.equal(payload.runId, "run_parent");
      assert.equal(payload.threadId, "thread_1");
      assert.equal(payload.messageId, "msg_1");
      assert.equal(payload.subAgent?.childRunId, "run_child");
    }
    assert.equal(started.status, "started");
    assert.equal(terminal.status, "succeeded");
  });

  test("a bounced call carries nonExecution so the client retracts the nested card", () => {
    const terminal = toolCardTerminal(
      target,
      { toolCallId: "call_2", toolName: "github.search" },
      toolEventOutcome("github.search", {
        kind: "inactive_tool",
        result: { recovery: { toolName: "github.search" } },
      } as unknown as TerminalDispatchResult),
      { segmentIndex: NESTED_SEGMENT_INDEX },
    );
    assert.equal(terminal.nonExecution, true);
    assert.equal(chatToolSchema.safeParse(terminal).success, true);
  });
});

describe("provider-supplied identity is clamped, not rejected", () => {
  // A model can invent a tool name of any length. `publishEvent` throws on a
  // payload the schema rejects, and the boss's publish sits inside the awaited
  // commit hook — so an over-long name must degrade to a bounce
  // (`unknown_tool`, which self-corrects) rather than kill the run.
  const target = {
    runId: "run_parent",
    threadId: "thread_1",
    messageId: "msg_1",
  };
  const longName = "z".repeat(CHAT_TOOL_NAME_MAX + 1);
  const longCallId = "c".repeat(CHAT_TOOL_CALL_ID_MAX + 1);

  test("an over-long started card still parses clean", () => {
    const started = toolCardStarted(
      target,
      { toolCallId: longCallId, toolName: longName, input: {} },
      0,
    );
    assert.equal(started.toolName.length, CHAT_TOOL_NAME_MAX);
    assert.equal(started.toolCallId.length, CHAT_TOOL_CALL_ID_MAX);
    assert.equal(chatToolSchema.safeParse(started).success, true);
  });

  test("an over-long terminal card still parses clean", () => {
    const terminal = toolCardTerminal(
      target,
      { toolCallId: longCallId, toolName: longName },
      toolEventOutcome(longName, {
        kind: "unknown_tool",
        result: { reason: "unknown_tool" },
      } as unknown as TerminalDispatchResult),
      { segmentIndex: 0 },
    );
    assert.equal(terminal.toolName.length, CHAT_TOOL_NAME_MAX);
    assert.equal(terminal.toolCallId.length, CHAT_TOOL_CALL_ID_MAX);
    assert.equal(terminal.nonExecution, true);
    assert.equal(chatToolSchema.safeParse(terminal).success, true);
  });
});

describe("toolEventOutcome", () => {
  const executed = (toolResult: unknown, sanitized?: boolean): TerminalDispatchResult =>
    ({
      kind: "executed",
      toolResult,
      ...(sanitized ? { sanitized } : {}),
    }) as TerminalDispatchResult;

  test("an executed read succeeds and is never flagged as non-execution", () => {
    const outcome = toolEventOutcome("gmail.search", executed({ messages: [] }));
    assert.equal(outcome.status, "succeeded");
    assert.equal(outcome.nonExecution, undefined);
  });

  test("a dispatcher bounce is flagged so both publishers retract the card", () => {
    // This is the field the whole nonExecution contract hangs on: the chat turn
    // and the sub-agent trail derive it here so they cannot drift, and a surface
    // that lost it would render internal plumbing as a user-facing failure.
    for (const kind of ["invalid_input", "unknown_tool", "inactive_tool", "not_allowed"] as const) {
      const outcome = toolEventOutcome("gmail.search", {
        kind,
        result: { reason: kind },
      } as unknown as TerminalDispatchResult);
      assert.equal(outcome.status, "failed", kind);
      assert.equal(outcome.nonExecution, true, kind);
    }
  });

  test("a real execution fault is a visible failure, not a bounce", () => {
    const outcome = toolEventOutcome("gmail.send_draft", {
      kind: "failed",
      error: { message: "upstream 500" },
    } as unknown as TerminalDispatchResult);
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.nonExecution, undefined);
  });

  test("the ADR-0070 sanitizer verdict rides along", () => {
    assert.equal(toolEventOutcome("gmail.search", executed({ ok: true }, true)).sanitized, true);
    assert.equal(toolEventOutcome("gmail.search", executed({ ok: true })).sanitized, undefined);
  });
});
