import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  guardUnreportedToolFailures,
  type ChatRunState,
  type GuardUnreportedToolFailuresDeps,
} from "../../src/modules/agent/workflows/chat-turn";
import type { StepContext } from "../../src/modules/agent/types";

/**
 * Unit tests for the #346 honesty guard. The invariant: a turn whose mutating
 * tool calls net-failed cannot finalize while still claiming success — the guard
 * injects a corrective note and forces a regeneration, exactly once per failure
 * (so it can't loop). Reads and recovered (failed-then-succeeded) tools never
 * fire. The tool classifier and event bus are injected so no live registry or
 * Redis is needed.
 */

const RUN_ID = "run_1";
const USER_ID = "user_1";

function baseState(overrides: Partial<ChatRunState> = {}): ChatRunState {
  return {
    threadId: "thread_1",
    messageId: "msg_1",
    tier: "standard",
    activeIntegrations: [],
    allowedIntegrations: [],
    pendingToolCalls: [],
    assistantText: "I've created your spreadsheet.",
    narration: [],
    segmentIndex: 0,
    reasoningText: "",
    reasoningMs: 0,
    toolCallsLog: [],
    deltaSeq: 7,
    reasoningSeq: 0,
    turnCount: 1,
    started: true,
    foldedChildRunIds: [],
    notedFailureToolCallIds: [],
    ...overrides,
  };
}

function baseCtx(state: ChatRunState): StepContext<ChatRunState> {
  return {
    runId: RUN_ID,
    userId: USER_ID,
    idempotencyKey: "key_1",
    attempt: 1,
    state,
    transcript: [],
    stageAction: () => {},
    log: async () => {},
    trace: () => {},
  };
}

interface Recorder {
  deps: GuardUnreportedToolFailuresDeps;
  published: Array<{ kind: string; payload: Record<string, unknown> }>;
}

/** Treats every tool name except an explicit `no_risk` allowlist as mutating. */
function recorder(readOnly: string[] = []): Recorder {
  const published: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const deps: GuardUnreportedToolFailuresDeps = {
    isMutating: (name) => !readOnly.includes(name),
    publish: async (event) => {
      published.push({ kind: event.kind, payload: event.payload as Record<string, unknown> });
    },
  };
  return { deps, published };
}

describe("guardUnreportedToolFailures", () => {
  test("fires on a net-failed mutating call: regenerates with a corrective note", async () => {
    const state = baseState({
      toolCallsLog: [
        { toolCallId: "tc_1", toolName: "sheets.append_values", status: "failed", segmentIndex: 0 },
      ],
    });
    const { deps, published } = recorder();
    const result = await guardUnreportedToolFailures(baseCtx(state), state, [], deps);

    assert.ok(result, "guard should take over finalization");
    assert.equal(result.kind, "next");
    assert.equal(result.kind === "next" ? result.nextStep : undefined, "chat-turn");

    // Corrective [system] note appended, naming the failed tool.
    const transcript = result.kind === "next" ? result.transcript : undefined;
    assert.ok(transcript, "guard should append a corrective note to the transcript");
    const last = transcript.at(-1)!;
    assert.equal(last.role, "user");
    assert.match(String(last.content), /\[system\]/);
    assert.match(String(last.content), /sheets\.append_values/);
    assert.match(String(last.content), /did not complete/i);

    // Failure recorded so the regenerated turn won't re-fire (no loop).
    assert.deepEqual(state.notedFailureToolCallIds, ["tc_1"]);

    // Premature false-success answer closed into narration + client advanced.
    assert.equal(state.assistantText, "");
    assert.equal(state.segmentIndex, 1);
    assert.deepEqual(
      state.narration.map((n) => n.text),
      ["I've created your spreadsheet."],
    );
    const delta = published.find((p) => p.kind === "chat.delta");
    assert.ok(delta, "should advance the client off the rejected answer");
    assert.equal(delta.payload.text, "");
    assert.equal(delta.payload.segmentIndex, 1);
  });

  test("does not fire when the same tool later succeeded (recovery)", async () => {
    const state = baseState({
      toolCallsLog: [
        { toolCallId: "tc_1", toolName: "sheets.update_values", status: "failed", segmentIndex: 0 },
        {
          toolCallId: "tc_2",
          toolName: "sheets.update_values",
          status: "succeeded",
          segmentIndex: 0,
        },
      ],
    });
    const { deps } = recorder();
    const result = await guardUnreportedToolFailures(baseCtx(state), state, [], deps);
    assert.equal(result, null);
  });

  test("does not fire for a failed read (non-mutating) tool", async () => {
    const state = baseState({
      toolCallsLog: [
        { toolCallId: "tc_1", toolName: "gmail.search", status: "failed", segmentIndex: 0 },
      ],
    });
    const { deps } = recorder(["gmail.search"]);
    const result = await guardUnreportedToolFailures(baseCtx(state), state, [], deps);
    assert.equal(result, null);
  });

  test("does not re-fire for an already-noted failure (idempotent / no loop)", async () => {
    const state = baseState({
      toolCallsLog: [
        { toolCallId: "tc_1", toolName: "sheets.append_values", status: "failed", segmentIndex: 0 },
      ],
      notedFailureToolCallIds: ["tc_1"],
    });
    const { deps } = recorder();
    const result = await guardUnreportedToolFailures(baseCtx(state), state, [], deps);
    assert.equal(result, null);
  });

  test("fires on a partial failure: one mutation succeeded, another net-failed", async () => {
    const state = baseState({
      toolCallsLog: [
        {
          toolCallId: "tc_1",
          toolName: "sheets.append_values",
          status: "succeeded",
          segmentIndex: 0,
        },
        { toolCallId: "tc_2", toolName: "sheets.batch_update", status: "failed", segmentIndex: 0 },
      ],
    });
    const { deps } = recorder();
    const result = await guardUnreportedToolFailures(baseCtx(state), state, [], deps);
    assert.ok(result);
    assert.equal(result.kind, "next");
    const transcript = result.kind === "next" ? result.transcript : undefined;
    assert.ok(transcript);
    const note = String(transcript.at(-1)!.content);
    assert.match(note, /sheets\.batch_update/);
    assert.ok(!note.includes("append_values"));
    assert.deepEqual(state.notedFailureToolCallIds, ["tc_2"]);
  });

  test("does nothing on a clean turn (no failures)", async () => {
    const state = baseState({
      toolCallsLog: [
        {
          toolCallId: "tc_1",
          toolName: "sheets.append_values",
          status: "succeeded",
          segmentIndex: 0,
        },
      ],
    });
    const { deps } = recorder();
    const result = await guardUnreportedToolFailures(baseCtx(state), state, [], deps);
    assert.equal(result, null);
  });
});
