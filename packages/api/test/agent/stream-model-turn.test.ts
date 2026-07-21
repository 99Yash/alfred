import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ToolName } from "@alfred/contracts";

import type { publishEvent } from "../../src/events/publish";
import { sanitizeVoice } from "../../src/modules/agent/voice-sanitize";
import {
  streamModelTurn,
  type StreamTurnState,
} from "../../src/modules/agent/workflows/stream-model-turn";
import type { TurnStopController } from "../../src/modules/agent/workflows/turn-stop-controller";

/**
 * Unit tests for the extracted live-stream drain. Exercises the four stream
 * machines (reply-text flush, reasoning flush, artifact-input stream, and the
 * `for await` drain) against a fake async-iterable stream and a capturing event
 * sink injected via the new `publish` seam — no live provider, Redis, or DB.
 *
 * Invariants covered: coalesced reply text emits monotonically-sequenced
 * `chat.delta`; reasoning emits `chat.reasoning`; a tool call emits a `chat.tool`
 * started card only for an active tool; a document artifact's `markdown`
 * argument streams as `artifact.delta` chunked under the event cap; the live
 * voice sanitizer strips em-dashes so the stream matches the persisted bubble;
 * the `reissuePending` gate (#407) withholds the reply until the caller releases
 * it; and a mid-drain stop breaks the loop.
 */

interface CapturedEvent {
  kind: string;
  payload: Record<string, unknown>;
}

function capture(): { events: CapturedEvent[]; publish: typeof publishEvent } {
  const events: CapturedEvent[] = [];
  const publish = (async (args: { kind: string; payload: Record<string, unknown> }) => {
    events.push({ kind: args.kind, payload: args.payload });
  }) as typeof publishEvent;
  return { events, publish };
}

type StreamArg = Parameters<typeof streamModelTurn>[0]["stream"];

function makeStream(parts: unknown[]): StreamArg {
  return {
    stream: (async function* () {
      for (const part of parts) yield part;
    })(),
  } as unknown as StreamArg;
}

function makeState(over?: Partial<StreamTurnState>): StreamTurnState {
  return {
    threadId: "thread-1",
    messageId: "msg-1",
    activeTools: [],
    segmentIndex: 0,
    reissuePending: false,
    assistantText: "",
    reasoningText: "",
    reasoningMs: 0,
    deltaSeq: 0,
    reasoningSeq: 0,
    ...over,
  };
}

/**
 * A stop controller stub. `stopAfter` is the number of parts to process before
 * a stop is observed: `checkStop` (called once at the top of each iteration)
 * returns false for the first `stopAfter` calls, then latches `stopped`.
 */
function stubStop(opts?: { stopAfter?: number }): TurnStopController {
  let count = 0;
  let stopped = false;
  return {
    signal: new AbortController().signal,
    get stopped() {
      return stopped;
    },
    checkStop: async () => {
      count += 1;
      if (opts?.stopAfter !== undefined && count > opts.stopAfter) stopped = true;
      return stopped;
    },
    startPolling: () => () => {},
  };
}

const ctx = { userId: "user-1", runId: "run-1" };

describe("streamModelTurn", () => {
  test("coalesces reply text into a single sequenced chat.delta", async () => {
    const { events, publish } = capture();
    const state = makeState();
    await streamModelTurn({
      stream: makeStream([
        { type: "text-delta", text: "Hello " },
        { type: "text-delta", text: "world" },
      ]),
      state,
      ctx,
      stopController: stubStop(),
      publish,
    });

    const deltas = events.filter((e) => e.kind === "chat.delta");
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0]!.payload.text, "Hello world");
    assert.equal(deltas[0]!.payload.seq, 1);
    assert.equal(deltas[0]!.payload.segmentIndex, 0);
    assert.equal(state.assistantText, "Hello world");
    assert.equal(state.deltaSeq, 1);
  });

  test("emits reasoning as chat.reasoning and closes the duration", async () => {
    const { events, publish } = capture();
    const state = makeState();
    await streamModelTurn({
      stream: makeStream([
        { type: "reasoning-delta", text: "let me think" },
        { type: "reasoning-end" },
      ]),
      state,
      ctx,
      stopController: stubStop(),
      publish,
    });

    const reasoning = events.filter((e) => e.kind === "chat.reasoning");
    assert.equal(reasoning.length, 1);
    assert.equal(reasoning[0]!.payload.text, "let me think");
    assert.equal(reasoning[0]!.payload.seq, 1);
    assert.equal(state.reasoningText, "let me think");
    assert.ok(state.reasoningMs >= 0);
  });

  test("surfaces a started tool card only for an active tool", async () => {
    const toolName = "system.fetch_url" as ToolName;
    const { events, publish } = capture();
    await streamModelTurn({
      stream: makeStream([
        { type: "tool-call", toolCallId: "call-1", toolName, input: { url: "https://x" } },
      ]),
      state: makeState({ activeTools: [toolName] }),
      ctx,
      stopController: stubStop(),
      publish,
    });

    const tools = events.filter((e) => e.kind === "chat.tool");
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.payload.toolCallId, "call-1");
    assert.equal(tools[0]!.payload.toolName, toolName);
    assert.equal(tools[0]!.payload.status, "started");
    assert.equal(typeof tools[0]!.payload.argsPreview, "string");
  });

  test("does not surface a card for an inactive tool", async () => {
    const { events, publish } = capture();
    await streamModelTurn({
      stream: makeStream([
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "system.fetch_url" as ToolName,
          input: {},
        },
      ]),
      state: makeState({ activeTools: [] }),
      ctx,
      stopController: stubStop(),
      publish,
    });
    assert.equal(events.filter((e) => e.kind === "chat.tool").length, 0);
  });

  test("streams a document artifact's markdown as artifact.delta with its title", async () => {
    const { events, publish } = capture();
    await streamModelTurn({
      stream: makeStream([
        { type: "tool-input-start", id: "art-1", toolName: "system.create_artifact" },
        {
          type: "tool-input-delta",
          id: "art-1",
          delta: JSON.stringify({ title: "Plan", markdown: "hello body" }),
        },
        {
          type: "tool-call",
          toolCallId: "art-1",
          toolName: "system.create_artifact" as ToolName,
          input: { title: "Plan", markdown: "hello body" },
        },
      ]),
      state: makeState(),
      ctx,
      stopController: stubStop(),
      publish,
    });

    const artifactDeltas = events.filter((e) => e.kind === "artifact.delta");
    assert.ok(artifactDeltas.length >= 1);
    const body = artifactDeltas.map((e) => e.payload.text as string).join("");
    assert.equal(body, "hello body");
    assert.equal(artifactDeltas[0]!.payload.mode, "replace");
    assert.equal(artifactDeltas[0]!.payload.title, "Plan");
    assert.equal(artifactDeltas[0]!.payload.toolCallId, "art-1");
  });

  test("chunks an oversized artifact body under the event cap", async () => {
    const CHAT_DELTA_MAX = 16_000;
    const bigBody = "x".repeat(CHAT_DELTA_MAX + 1);
    const { events, publish } = capture();
    await streamModelTurn({
      stream: makeStream([
        { type: "tool-input-start", id: "art-1", toolName: "system.update_artifact" },
        {
          type: "tool-input-delta",
          id: "art-1",
          delta: JSON.stringify({ markdown: bigBody }),
        },
        {
          type: "tool-call",
          toolCallId: "art-1",
          toolName: "system.update_artifact" as ToolName,
          input: { markdown: bigBody },
        },
      ]),
      state: makeState(),
      ctx,
      stopController: stubStop(),
      publish,
    });

    const artifactDeltas = events.filter((e) => e.kind === "artifact.delta");
    assert.ok(artifactDeltas.length >= 2, "an over-cap body must split into multiple deltas");
    for (const delta of artifactDeltas) {
      assert.ok((delta.payload.text as string).length <= CHAT_DELTA_MAX);
    }
    assert.equal(artifactDeltas.map((e) => e.payload.text as string).join(""), bigBody);
  });

  test("strips em-dashes on the live stream to match the persisted bubble", async () => {
    const input = "Alfred — the assistant";
    const { events, publish } = capture();
    await streamModelTurn({
      stream: makeStream([{ type: "text-delta", text: input }]),
      state: makeState(),
      ctx,
      stopController: stubStop(),
      publish,
    });

    const streamed = events
      .filter((e) => e.kind === "chat.delta")
      .map((e) => e.payload.text as string)
      .join("");
    assert.ok(!streamed.includes("—"), "no em-dash reaches the live stream");
    assert.equal(streamed, sanitizeVoice(input), "streamed text matches the reconciled bubble");
  });

  test("withholds the reply while a reissue is pending, then releases on flushReply", async () => {
    const { events, publish } = capture();
    const state = makeState({ reissuePending: true });
    const { flushReply, flushReplyTail } = await streamModelTurn({
      stream: makeStream([{ type: "text-delta", text: "reissue lead-in" }]),
      state,
      ctx,
      stopController: stubStop(),
      publish,
    });

    // Held back during the drain: nothing streamed while the gate was closed.
    assert.equal(events.filter((e) => e.kind === "chat.delta").length, 0);
    assert.equal(state.assistantText, "reissue lead-in");

    // The caller clears the flag and releases what the gate withheld.
    state.reissuePending = false;
    await flushReply();
    await flushReplyTail();
    const deltas = events.filter((e) => e.kind === "chat.delta");
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0]!.payload.text, "reissue lead-in");
  });

  test("breaks the drain when a stop is observed mid-stream", async () => {
    const { events, publish } = capture();
    const state = makeState();
    await streamModelTurn({
      stream: makeStream([
        { type: "text-delta", text: "before" },
        { type: "text-delta", text: "after" },
      ]),
      state,
      ctx,
      // Process exactly one part, then observe the stop before the second.
      stopController: stubStop({ stopAfter: 1 }),
      publish,
    });

    assert.equal(state.assistantText, "before", "the post-stop part is never processed");
    const streamed = events
      .filter((e) => e.kind === "chat.delta")
      .map((e) => e.payload.text as string)
      .join("");
    assert.ok(!streamed.includes("after"));
  });
});
