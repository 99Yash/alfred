import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isNonExecutionFailure, toolCallLogStatus } from "../../src/modules/dispatch";
import {
  guardUnreportedToolFailures,
  sanitizeChatMessageFields,
  type ChatRunState,
  type GuardUnreportedToolFailuresDeps,
} from "../../src/modules/agent/workflows/chat-turn";
import { shouldPublishToolStarted } from "../../src/modules/agent/workflows/stream-model-turn";
import type { StepContext } from "../../src/modules/agent/types";

/**
 * Unit tests for the #346 honesty guard. The invariant: a turn whose mutating
 * tool calls failed cannot finalize while still claiming success — the guard
 * injects a corrective note and forces a regeneration, exactly once per failure
 * (so it can't loop). Reads never fire. The tool classifier and event bus are
 * injected for most tests so no live registry or Redis is needed.
 */

const RUN_ID = "run_1";
const USER_ID = "user_1";

function baseState(overrides: Partial<ChatRunState> = {}): ChatRunState {
  return {
    threadId: "thread_1",
    messageId: "msg_1",
    tier: "standard",
    activeTools: [],
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
    emptyCompletionRetries: 0,
    streamTimeoutRetries: 0,
    startedAt: "2026-07-14T02:50:11.451Z",
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
  test("fires on a failed mutating call: regenerates with a corrective note", async () => {
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

  test("still fires when another call with the same tool name succeeded", async () => {
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
    assert.ok(result, "same tool name success is not proof that the failed side effect recovered");
    assert.equal(result.kind, "next");
    assert.deepEqual(state.notedFailureToolCallIds, ["tc_1"]);
    const transcript = result.kind === "next" ? result.transcript : undefined;
    assert.ok(transcript);
    const note = String(transcript.at(-1)!.content);
    assert.match(note, /sheets\.update_values/);
    assert.match(note, /completed the user's goal another way/);
  });

  test("ignores a self-corrected invalid_input failure when a later call succeeded", async () => {
    // The #346 follow-up bug: a first `gmail.send_draft` failed schema
    // validation (never executed), the model corrected it and the resend was
    // approved + executed. The guard must NOT fire — otherwise it denies a send
    // that actually went through.
    const state = baseState({
      assistantText: "Done. Email sent.",
      toolCallsLog: [
        {
          toolCallId: "tc_1",
          toolName: "gmail.send_draft",
          status: "failed",
          nonExecution: true,
          segmentIndex: 0,
        },
        {
          toolCallId: "tc_2",
          toolName: "gmail.send_draft",
          status: "succeeded",
          segmentIndex: 1,
        },
      ],
    });
    const { deps } = recorder();
    const result = await guardUnreportedToolFailures(baseCtx(state), state, [], deps);
    assert.equal(result, null, "a never-executed, self-corrected call must not trip the guard");
    assert.deepEqual(state.notedFailureToolCallIds, []);
  });

  test("fires for a lone non-execution failure (malformed write, no successful retry)", async () => {
    const state = baseState({
      toolCallsLog: [
        {
          toolCallId: "tc_1",
          toolName: "gmail.send_draft",
          status: "failed",
          nonExecution: true,
          segmentIndex: 0,
        },
      ],
    });
    const { deps } = recorder();
    const result = await guardUnreportedToolFailures(baseCtx(state), state, [], deps);
    assert.ok(
      result,
      "a malformed write with no later success can still produce false-success text",
    );
    assert.equal(result.kind, "next");
    assert.deepEqual(state.notedFailureToolCallIds, ["tc_1"]);
  });

  test("still fires for a real execution failure (no nonExecution flag)", async () => {
    const state = baseState({
      toolCallsLog: [
        { toolCallId: "tc_1", toolName: "gmail.send_draft", status: "failed", segmentIndex: 0 },
      ],
    });
    const { deps } = recorder();
    const result = await guardUnreportedToolFailures(baseCtx(state), state, [], deps);
    assert.ok(result, "a genuine execution failure must still force honesty");
    assert.equal(result.kind, "next");
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

  test("does not fire for sensitive read tools that use non-no_risk tiers", async () => {
    const state = baseState({
      toolCallsLog: [
        { toolCallId: "tc_1", toolName: "docs.get_document", status: "failed", segmentIndex: 0 },
      ],
    });
    const result = await guardUnreportedToolFailures(baseCtx(state), state, [], {
      publish: async () => {},
    });
    assert.equal(result, null);
  });

  test("fires for no-risk system tools that still create user-visible state", async () => {
    const state = baseState({
      toolCallsLog: [
        {
          toolCallId: "tc_1",
          toolName: "system.create_artifact",
          status: "failed",
          segmentIndex: 0,
        },
      ],
    });
    const result = await guardUnreportedToolFailures(baseCtx(state), state, [], {
      publish: async () => {},
    });
    assert.ok(result, "no-risk artifact writes still need the honesty guard");
    assert.equal(result.kind, "next");
    assert.deepEqual(state.notedFailureToolCallIds, ["tc_1"]);
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

  test("fires for an unknown write-shaped tool name", async () => {
    const state = baseState({
      toolCallsLog: [
        {
          toolCallId: "tc_1",
          toolName: "sheets.write_values",
          status: "failed",
          nonExecution: true,
          segmentIndex: 0,
        },
      ],
    });
    const published: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const result = await guardUnreportedToolFailures(baseCtx(state), state, [], {
      publish: async (event) => {
        published.push({ kind: event.kind, payload: event.payload as Record<string, unknown> });
      },
    });

    assert.ok(result, "unknown write-like tools should still force honesty");
    assert.equal(result.kind, "next");
    assert.deepEqual(state.notedFailureToolCallIds, ["tc_1"]);
    assert.equal(published.length, 1);
  });

  test("does not fire for an unknown read-shaped tool name", async () => {
    const state = baseState({
      toolCallsLog: [
        {
          toolCallId: "tc_1",
          toolName: "github.list_pull_requests",
          status: "failed",
          segmentIndex: 0,
        },
      ],
    });
    const result = await guardUnreportedToolFailures(baseCtx(state), state, [], {
      publish: async () => {},
    });
    assert.equal(result, null);
  });

  test("fires on a partial failure: one mutation succeeded, another failed", async () => {
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

  test("marks semantic failures from mutating tools as failed for the guard", () => {
    assert.equal(
      toolCallLogStatus("system.create_artifact", {
        kind: "executed",
        stagingId: null,
        toolResult: { ok: false, status: "no_thread" },
        editedByUser: false,
      }),
      "failed",
    );
    assert.equal(
      toolCallLogStatus("system.update_artifact", {
        kind: "executed",
        stagingId: null,
        toolResult: { ok: false, status: "not_found" },
        editedByUser: false,
      }),
      "failed",
    );
  });

  test("does not treat read-tool not_found payloads as failed actions", () => {
    assert.equal(
      toolCallLogStatus("gmail.read_message", {
        kind: "executed",
        stagingId: null,
        toolResult: { status: "not_found", messageId: "msg_missing" },
        editedByUser: false,
      }),
      "succeeded",
    );
  });

  test("classifies every pre-execution dispatcher rejection as non-execution", () => {
    assert.equal(
      isNonExecutionFailure({
        kind: "not_allowed",
        result: {
          status: "not_allowed",
          toolName: "gmail.search",
          integration: "gmail",
          message: "not allowed",
        },
      }),
      true,
    );
  });

  test("hides non-execution attempts from persisted tool cards", () => {
    const fields = sanitizeChatMessageFields(
      baseState({
        toolCallsLog: [
          {
            toolCallId: "tc_bounce",
            toolName: "gmail.search",
            status: "failed",
            nonExecution: true,
            segmentIndex: 0,
          },
          {
            toolCallId: "tc_retry",
            toolName: "gmail.search",
            status: "succeeded",
            segmentIndex: 1,
          },
        ],
      }),
    );

    assert.deepEqual(
      fields.toolCalls?.map((toolCall) => toolCall.toolCallId),
      ["tc_retry"],
    );
  });

  test("publishes optimistic cards only for active tools", () => {
    assert.equal(shouldPublishToolStarted(["gmail.search"], "gmail.search"), true);
    assert.equal(shouldPublishToolStarted([], "gmail.search"), false);
    assert.equal(shouldPublishToolStarted(["gmail.search"], "gmail.invented"), false);
  });
});

/**
 * The chat boss is *told* DEFAULT_VOICE_PROMPT ("No em-dashes") but a prompt is
 * not a guarantee, so `sanitizeChatMessageFields` mechanically enforces it on
 * the two fields that are Alfred's own final prose — `content` and each
 * `narration` segment — the same way briefing's `compose.ts` does. Reasoning
 * (internal chain-of-thought) and tool previews (raw tool data) stay verbatim.
 */
describe("sanitizeChatMessageFields — voice enforcement", () => {
  test("strips em-dashes from the final content", () => {
    const fields = sanitizeChatMessageFields(
      baseState({ assistantText: "The report is complete — just over 8,500 words." }),
    );
    assert.equal(fields.content, "The report is complete; just over 8,500 words.");
  });

  test("strips em-dashes from each narration segment", () => {
    const fields = sanitizeChatMessageFields(
      baseState({
        assistantText: "Done.",
        narration: [
          { index: 0, text: "Searching your inbox — one moment." },
          { index: 1, text: "Found it—drafting a reply." },
        ],
      }),
    );
    assert.deepEqual(fields.narration, [
      { index: 0, text: "Searching your inbox; one moment." },
      { index: 1, text: "Found it; drafting a reply." },
    ]);
  });

  test("preserves code, quotations, and links in content verbatim", () => {
    const fields = sanitizeChatMessageFields(
      baseState({
        assistantText:
          'Run `foo—bar`, cite "keep this — exactly", see [docs](https://x.com/a—b) — done.',
      }),
    );
    assert.equal(
      fields.content,
      'Run `foo—bar`, cite "keep this — exactly", see [docs](https://x.com/a—b); done.',
    );
  });

  test("leaves reasoning (internal chain-of-thought) untouched", () => {
    const fields = sanitizeChatMessageFields(
      baseState({
        assistantText: "Answer.",
        reasoningText: "The user wants X — I should do Y.",
      }),
    );
    assert.equal(fields.reasoning, "The user wants X — I should do Y.");
  });

  test("clean prose is unchanged", () => {
    const clean = "Tuesday works. I'll send the deck beforehand.";
    const fields = sanitizeChatMessageFields(baseState({ assistantText: clean }));
    assert.equal(fields.content, clean);
  });
});
