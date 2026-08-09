import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CHAT_TOOL_CALL_ID_MAX,
  CHAT_TOOL_NAME_MAX,
  chatToolSchema,
} from "@alfred/contracts/events";
import type { CompletedToolCall } from "@alfred/assistant/tool-runtime";
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

function completion(
  toolName: string,
  result: unknown,
  options: Partial<Omit<CompletedToolCall, "call" | "result">> = {},
): CompletedToolCall {
  return {
    call: { toolCallId: "call", toolName, input: {} },
    result,
    status: "succeeded",
    execution: "completed",
    sanitized: false,
    nonExecution: false,
    ...options,
  };
}

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

  // A liveness predicate that records whether it was consulted, so a test can
  // prove the door asks the parent-open question — and skips it when there is no
  // chat turn to publish to.
  function openStub(answer: boolean) {
    let asked = 0;
    return {
      isParentOpen: async () => {
        asked += 1;
        return answer;
      },
      wasAsked: () => asked > 0,
    };
  }

  // The door only mints a target for a live parent; every card test needs one.
  async function liveTarget() {
    const target = await subAgentToolCardTarget(
      child,
      "run_child",
      "user_1",
      openStub(true).isParentOpen,
    );
    assert.ok(target, "a live parent yields a target");
    return target;
  }

  test("the door refuses to mint a target when the injected predicate says closed", async () => {
    // This is the gate item 38 introduced, now folded INTO the door: a terminal
    // parent's barrier never releases, so no card may be republished under it.
    const shut = openStub(false);
    assert.equal(
      await subAgentToolCardTarget(child, "run_child", "user_1", shut.isParentOpen),
      null,
    );
    assert.equal(
      shut.wasAsked(),
      true,
      "the closed answer came from the predicate, not a short-circuit",
    );
  });

  test("the event is addressed to the PARENT run, never the child", async () => {
    // The client keys its in-flight turn on (messageId, runId). A child runId
    // here would read as a new turn and blank the bubble mid-stream, so this is
    // the one field worth pinning.
    const target = await liveTarget();
    assert.equal(target.runId, "run_parent");
    assert.notEqual(target.runId, "run_child");
    assert.deepEqual(target.subAgent, {
      parentToolCallId: "call_spawn",
      subId: "sub_a",
      childRunId: "run_child",
    });
  });

  test("no target for the boss, or for a child of a background parent — and no liveness read for either", async () => {
    // Neither case has a chat turn to publish to, so the door short-circuits
    // BEFORE the DB read: there is no parent barrier to reason about.
    const bossStub = openStub(true);
    assert.equal(
      await subAgentToolCardTarget(null, "run_child", "user_1", bossStub.isParentOpen),
      null,
    );
    const { chat: _chat, ...noChat } = child;
    const bgStub = openStub(true);
    assert.equal(
      await subAgentToolCardTarget(noChat, "run_child", "user_1", bgStub.isParentOpen),
      null,
    );
    assert.equal(bossStub.wasAsked(), false);
    assert.equal(bgStub.wasAsked(), false);
  });

  test("both payloads satisfy the wire schema and keep parent addressing", async () => {
    const target = await liveTarget();
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
      toolEventOutcome(completion("github.search", { items: [] })),
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

  test("a bounced call carries nonExecution so the client retracts the nested card", async () => {
    const target = await liveTarget();
    const terminal = toolCardTerminal(
      target,
      { toolCallId: "call_2", toolName: "github.search" },
      toolEventOutcome(
        completion(
          "github.search",
          { recovery: { toolName: "github.search" } },
          {
            status: "failed",
            execution: "not_reached",
            nonExecution: true,
          },
        ),
      ),
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
      toolEventOutcome(
        completion(
          longName,
          { reason: "unknown_tool" },
          {
            status: "failed",
            execution: "not_reached",
            nonExecution: true,
          },
        ),
      ),
      { segmentIndex: 0 },
    );
    assert.equal(terminal.toolName.length, CHAT_TOOL_NAME_MAX);
    assert.equal(terminal.toolCallId.length, CHAT_TOOL_CALL_ID_MAX);
    assert.equal(terminal.nonExecution, true);
    assert.equal(chatToolSchema.safeParse(terminal).success, true);
  });
});

describe("toolEventOutcome", () => {
  test("an executed read succeeds and is never flagged as non-execution", () => {
    const outcome = toolEventOutcome(completion("gmail.search", { messages: [] }));
    assert.equal(outcome.status, "succeeded");
    assert.equal(outcome.nonExecution, undefined);
  });

  test("a dispatcher bounce is flagged so both publishers retract the card", () => {
    // This is the field the whole nonExecution contract hangs on: the chat turn
    // and the sub-agent trail derive it here so they cannot drift, and a surface
    // that lost it would render internal plumbing as a user-facing failure.
    for (const kind of ["invalid_input", "unknown_tool", "inactive_tool", "not_allowed"] as const) {
      const outcome = toolEventOutcome(
        completion(
          "gmail.search",
          { reason: kind },
          {
            status: "failed",
            execution: "not_reached",
            nonExecution: true,
          },
        ),
      );
      assert.equal(outcome.status, "failed", kind);
      assert.equal(outcome.nonExecution, true, kind);
    }
  });

  test("a real execution fault is a visible failure, not a bounce", () => {
    const outcome = toolEventOutcome(
      completion(
        "gmail.send_draft",
        { message: "upstream 500" },
        {
          status: "failed",
          execution: "failed",
        },
      ),
    );
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.nonExecution, undefined);
  });

  test("the ADR-0070 sanitizer verdict rides along", () => {
    assert.equal(
      toolEventOutcome(completion("gmail.search", { ok: true }, { sanitized: true })).sanitized,
      true,
    );
    assert.equal(toolEventOutcome(completion("gmail.search", { ok: true })).sanitized, undefined);
  });
});
