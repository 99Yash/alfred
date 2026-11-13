import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { toDisplayText } from "@alfred/contracts";

import { sanitizeChatMessageFields } from "@alfred/assistant/chat/chat-turn-closure";
import {
  guardUnreportedToolFailures,
  type GuardUnreportedToolFailuresDeps,
} from "@alfred/assistant/chat/finalize-guards";
import type { ChatRunState } from "@alfred/assistant/chat/chat-turn-state";
import { shouldPublishToolStarted } from "@alfred/assistant/execution/workflows/tool-card-events";
import type { StepContext } from "@alfred/assistant/execution";

/**
 * A turn whose mutating tool call failed cannot finalize claiming success. The
 * guard adds a note and regenerates once per failure, so it cannot loop. Reads never fire.
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
    log: async () => {},
    trace: () => {},
  };
}

interface Recorder {
  deps: GuardUnreportedToolFailuresDeps;
  published: Array<{ kind: string; payload: Record<string, unknown> }>;
}

/** The reply check is a model call, so every test fixes its verdict. */
const claimsSuccess: GuardUnreportedToolFailuresDeps["judgeReply"] = async () => ({
  verdict: "claims_success",
  note: "",
});

/** Treats every failed call as a write, except calls of the tools named in `readOnly`. */
function recorder(readOnly: string[] = []): Recorder {
  const published: Array<{ kind: string; payload: Record<string, unknown> }> = [];

  const deps: GuardUnreportedToolFailuresDeps = {
    selectWrites: async (_ctx, calls) => calls.filter((call) => !readOnly.includes(call.toolName)),
    judgeReply: claimsSuccess,
    publish: async (event) => {
      published.push({ kind: event.kind, payload: event.payload });
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
    assert.equal(result.nextStep, "chat-turn");

    const transcript = result.transcript;
    assert.ok(transcript, "guard should append a corrective note to the transcript");
    const last = transcript.at(-1);
    assert.ok(last);
    assert.equal(last.role, "user");
    assert.match(toDisplayText(last.content), /\[system\]/);
    assert.match(toDisplayText(last.content), /sheets\.append_values/);
    assert.match(toDisplayText(last.content), /did not complete/i);

    // Recorded, so the regenerated turn does not fire again.
    assert.deepEqual(state.notedFailureToolCallIds, ["tc_1"]);

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
    const transcript = result.transcript;
    assert.ok(transcript);
    const last = transcript.at(-1);
    assert.ok(last);
    const note = toDisplayText(last.content);
    assert.match(note, /sheets\.update_values/);
    assert.match(note, /completed the user's goal another way/);
  });

  test("ignores a self-corrected invalid_input failure when a later call succeeded", async () => {
    // The failed call never executed and the corrected resend did. Firing would deny a real send.
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
      judgeReply: claimsSuccess,
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
      judgeReply: claimsSuccess,
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
      judgeReply: claimsSuccess,
      publish: async (event) => {
        published.push({ kind: event.kind, payload: event.payload });
      },
    });

    assert.ok(result, "unknown write-like tools should still force honesty");
    assert.equal(result.kind, "next");
    assert.deepEqual(state.notedFailureToolCallIds, ["tc_1"]);
    assert.equal(published.length, 1);
  });

  test("does not fire for a registered read tool", async () => {
    const state = baseState({
      toolCallsLog: [
        {
          toolCallId: "tc_1",
          toolName: "github.get_pull_requests",
          status: "failed",
          segmentIndex: 0,
        },
      ],
    });

    const result = await guardUnreportedToolFailures(baseCtx(state), state, [], {
      judgeReply: claimsSuccess,
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
    const transcript = result.transcript;
    assert.ok(transcript);
    const last = transcript.at(-1);
    assert.ok(last);
    const note = toDisplayText(last.content);
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

  test("keeps a connection-health bounce — it carries the repair offer (#378 item 3)", () => {
    const fields = sanitizeChatMessageFields(
      baseState({
        toolCallsLog: [
          {
            toolCallId: "tc_connect",
            toolName: "gmail.search",
            status: "failed",
            nonExecution: true,
            connectNudge: { integration: "gmail", action: "connect" },
            segmentIndex: 0,
          },
        ],
      }),
    );

    assert.deepEqual(fields.toolCalls, [
      {
        toolCallId: "tc_connect",
        toolName: "gmail.search",
        status: "failed",
        nonExecution: true,
        connectNudge: { integration: "gmail", action: "connect" },
        segmentIndex: 0,
      },
    ]);
  });

  test("publishes optimistic cards only for active tools", () => {
    assert.equal(shouldPublishToolStarted(["gmail.search"], "gmail.search"), true);
    assert.equal(shouldPublishToolStarted([], "gmail.search"), false);
    assert.equal(shouldPublishToolStarted(["gmail.search"], "gmail.invented"), false);
  });
});

/**
 * A prompt is not a guarantee, so voice is enforced on `content` and `narration`.
 * Reasoning and tool previews stay verbatim.
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

describe("guardUnreportedToolFailures with an unconfirmed effect", () => {
  /** The action record of `unconfirmedIds` has `retry: "blocked"`, so `selectWrites` marks them. */
  function unconfirmedRecorder(
    unconfirmedIds: string[],
    judgeReply: GuardUnreportedToolFailuresDeps["judgeReply"],
  ): Recorder {
    const published: Array<{ kind: string; payload: Record<string, unknown> }> = [];

    const deps: GuardUnreportedToolFailuresDeps = {
      selectWrites: async (_ctx, calls) =>
        calls.map((call) =>
          unconfirmedIds.includes(call.toolCallId) ? { ...call, effectUnconfirmed: true } : call,
        ),
      judgeReply,
      publish: async (event) => {
        published.push({ kind: event.kind, payload: event.payload });
      },
    };

    return { deps, published };
  }

  /** The reply check failed, so the guard appends the fallback note from code. */
  const judgeFails: GuardUnreportedToolFailuresDeps["judgeReply"] = async () => null;

  test("the fallback note for an unconfirmed write says it may have gone through", async () => {
    const state = baseState({
      assistantText: "Here is what I found.",
      toolCallsLog: [
        { toolCallId: "tc_mcp", toolName: "mcp.call", status: "failed", segmentIndex: 0 },
      ],
    });

    const { deps } = unconfirmedRecorder(["tc_mcp"], judgeFails);
    const result = await guardUnreportedToolFailures(baseCtx(state), state, [], deps);

    assert.equal(result, null, "the guard keeps the answer and appends a note");
    assert.doesNotMatch(state.assistantText, /Nothing changed/);
    assert.match(state.assistantText, /I couldn't confirm call a connected tool\./);
    assert.match(state.assistantText, /It may have gone through/);
  });

  test("the fallback note for a plain failed write keeps 'Nothing changed there.'", async () => {
    const state = baseState({
      assistantText: "Here is what I found.",
      toolCallsLog: [
        { toolCallId: "tc_1", toolName: "sheets.append_values", status: "failed", segmentIndex: 0 },
      ],
    });

    const { deps } = unconfirmedRecorder([], judgeFails);
    await guardUnreportedToolFailures(baseCtx(state), state, [], deps);

    assert.match(
      state.assistantText,
      /I couldn't append spreadsheet rows\. Nothing changed there\./,
    );
    assert.doesNotMatch(state.assistantText, /may have gone through/);
  });

  test("a mixed turn says 'Nothing changed' only for the write that did not land", async () => {
    const state = baseState({
      assistantText: "Here is what I found.",
      toolCallsLog: [
        { toolCallId: "tc_1", toolName: "sheets.append_values", status: "failed", segmentIndex: 0 },
        { toolCallId: "tc_mcp", toolName: "mcp.call", status: "failed", segmentIndex: 0 },
      ],
    });

    const { deps } = unconfirmedRecorder(["tc_mcp"], judgeFails);
    await guardUnreportedToolFailures(baseCtx(state), state, [], deps);

    assert.match(
      state.assistantText,
      /I couldn't append spreadsheet rows\. Nothing changed there\. I couldn't confirm call a connected tool\. It may have gone through/,
    );
  });

  test("on claims_success the regenerate note names the unconfirmed tool", async () => {
    const state = baseState({
      toolCallsLog: [
        { toolCallId: "tc_mcp", toolName: "mcp.call", status: "failed", segmentIndex: 0 },
      ],
    });

    const { deps } = unconfirmedRecorder(["tc_mcp"], claimsSuccess);
    const result = await guardUnreportedToolFailures(baseCtx(state), state, [], deps);

    assert.ok(result, "a false success claim regenerates the reply");
    assert.equal(result.kind, "next");
    const last = result.transcript?.at(-1);
    assert.ok(last);
    const note = toDisplayText(last.content);
    assert.match(note, /For mcp\.call, an attempt may have reached the target/);
    assert.match(note, /do not say that nothing changed/);
  });

  test("on claims_success a plain failed write gets no unconfirmed sentence", async () => {
    const state = baseState({
      toolCallsLog: [
        { toolCallId: "tc_1", toolName: "sheets.append_values", status: "failed", segmentIndex: 0 },
      ],
    });

    const { deps } = unconfirmedRecorder([], claimsSuccess);
    const result = await guardUnreportedToolFailures(baseCtx(state), state, [], deps);

    assert.ok(result);
    assert.equal(result.kind, "next");
    const last = result.transcript?.at(-1);
    assert.ok(last);
    assert.doesNotMatch(toDisplayText(last.content), /may have reached the target/);
  });
});
