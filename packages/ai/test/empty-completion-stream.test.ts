import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isStepCount, streamText, tool, type FinishReason, type LanguageModel } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

import { classifyStreamFinish } from "../src/agent";

/**
 * Streaming integration coverage for the empty-completion contract (2026-07-10
 * chat-turn dig). The sibling `empty-completion.test.ts` unit-tests
 * `classifyStreamFinish` on hand-fed inputs; it can't prove the *real* SDK
 * streaming machinery actually surfaces an empty Gemini candidate as
 * `finishReason:"stop"` + no tool calls + zero text — the exact runtime shape
 * the whole retry hinges on.
 *
 * So these tests drive the genuine `streamText` pipeline with a
 * `MockLanguageModelV4` `doStream`, drain `stream` accumulating text the
 * same way `chat-turn.ts` accumulates `state.assistantText`, then feed the
 * awaited `toolCalls` / `finishReason` into the production `classifyStreamFinish`
 * — mirroring `chat-turn.ts` line-for-line (drain → `Promise.all` →
 * `classifyStreamFinish({ toolCalls, finishReason, textLength })`). This closes
 * the streaming half of the handoff's "NOT verified" gap without standing up the
 * durable runtime.
 *
 * `withFallback` is deliberately out of scope: it degrades on *thrown* errors,
 * and an empty stream is a *successful* call (the exact reason degrading is the
 * executor's job). Faking an empty candidate at the model layer is the faithful
 * reproduction.
 */

// Derive the V4 stream-part union off the mock itself (same `ai` copy) rather
// than importing `@ai-sdk/provider`, which is only a transitive dependency —
// the same approach with-fallback.test.ts uses for its generate-result shape.
type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

// V4 usage shape, copied verbatim from with-fallback.test.ts's proven fixture.
const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

function streamPart(part: StreamPart): StreamPart {
  return part;
}

function finishPart(unified: FinishReason): StreamPart {
  return streamPart({ type: "finish", finishReason: { unified, raw: unified }, usage: USAGE });
}

const START = streamPart({ type: "stream-start", warnings: [] });
const RESPONSE_META = streamPart({
  type: "response-metadata",
  id: "resp-0",
  modelId: "mock-model",
  timestamp: new Date(0),
});

/** Text parts for a single streamed span with the given body. */
function textParts(body: string): StreamPart[] {
  return [
    streamPart({ type: "text-start", id: "txt-0" }),
    streamPart({ type: "text-delta", id: "txt-0", delta: body }),
    streamPart({ type: "text-end", id: "txt-0" }),
  ];
}

/** A single tool-call span whose input matches the `ping` tool's schema. */
function toolCallParts(): StreamPart[] {
  return [
    streamPart({ type: "tool-input-start", id: "call-0", toolName: "ping" }),
    streamPart({ type: "tool-input-delta", id: "call-0", delta: '{"ok":true}' }),
    streamPart({ type: "tool-input-end", id: "call-0" }),
    streamPart({
      type: "tool-call",
      toolCallId: "call-0",
      toolName: "ping",
      input: '{"ok":true}',
    }),
  ];
}

// SAFETY: this SDK-provided V4 mock implements the runtime branch streamText consumes.
const asModel = (m: MockLanguageModelV4) => m as unknown as LanguageModel;

// An `execute`-less tool: same as production (dispatch happens in a later step),
// so `stopWhen: isStepCount(1)` means the SDK surfaces the call without running it.
const pingTool = tool({
  description: "test tool",
  inputSchema: z.object({ ok: z.boolean() }),
});

/**
 * Drive the real SDK streaming path exactly as `chat-turn.ts` does and return
 * the production classification plus the drained primitives for assertion.
 */
async function driveStream(parts: StreamPart[]) {
  const model = new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-model",
    doStream: async () => ({ stream: convertArrayToReadableStream(parts) }),
  });

  const stream = streamText({
    model: asModel(model),
    prompt: "hi",
    tools: { ping: pingTool },
    // Mirror the agent: one model request, no SDK-level dispatch or retry.
    stopWhen: isStepCount(1),
    maxRetries: 0,
  });

  // Accumulate assistant text off the live stream the way the executor builds
  // `state.assistantText` — the value it passes to `classifyStreamFinish`.
  let assistantText = "";
  for await (const part of stream.stream) {
    if (part.type === "text-delta") assistantText += part.text;
  }

  const [toolCalls, finishReason] = await Promise.all([stream.toolCalls, stream.finishReason]);
  const outcome = classifyStreamFinish({
    toolCalls,
    finishReason,
    textLength: assistantText.trim().length,
  });
  return { outcome, toolCalls, finishReason, assistantText };
}

describe("classifyStreamFinish over a real streamText drain", () => {
  test("empty stop candidate → empty (the Anthropic→Gemini quota-fallback anomaly)", async () => {
    // What Gemini 2.5 Pro throws under the quota fallback: a clean finish with
    // zero content. The SDK call SUCCEEDS, so nothing upstream can catch it.
    const { outcome, toolCalls, finishReason, assistantText } = await driveStream([
      START,
      RESPONSE_META,
      finishPart("stop"),
    ]);
    assert.equal(finishReason, "stop", "the SDK surfaces the empty candidate as a clean stop");
    assert.equal(toolCalls.length, 0);
    assert.equal(assistantText, "");
    assert.equal(outcome.kind, "empty", "→ retryable, not a dead-ended failure");
  });

  test("empty error finish → empty (transient provider fault with no content)", async () => {
    const { outcome } = await driveStream([START, RESPONSE_META, finishPart("error")]);
    assert.equal(outcome.kind, "empty");
  });

  test("real streamed text → final (never misread as empty)", async () => {
    const { outcome, assistantText, finishReason } = await driveStream([
      START,
      RESPONSE_META,
      ...textParts("Here is your answer."),
      finishPart("stop"),
    ]);
    assert.equal(finishReason, "stop");
    assert.equal(assistantText, "Here is your answer.");
    assert.equal(outcome.kind, "final");
  });

  test("empty content-filter → stopped (safety block won't self-heal on retry)", async () => {
    const { outcome } = await driveStream([START, RESPONSE_META, finishPart("content-filter")]);
    assert.equal(outcome.kind, "stopped");
    assert.equal(outcome.kind === "stopped" ? outcome.reason : undefined, "content-filter");
  });

  test("empty length → stopped (budget exhausted, not a transient empty)", async () => {
    const { outcome } = await driveStream([START, RESPONSE_META, finishPart("length")]);
    assert.equal(outcome.kind, "stopped");
    assert.equal(outcome.kind === "stopped" ? outcome.reason : undefined, "length");
  });

  test("streamed tool call with no prose → tool-calls (tool calls outrank empty)", async () => {
    // A tool-call turn legitimately emits zero assistant text; the empty check
    // must not swallow it. `finishReason` is `tool-calls` here.
    const { outcome, toolCalls, assistantText } = await driveStream([
      START,
      RESPONSE_META,
      ...toolCallParts(),
      finishPart("tool-calls"),
    ]);
    assert.equal(assistantText, "", "a tool-call turn carries no prose");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0]?.toolName, "ping");
    assert.equal(outcome.kind, "tool-calls");
  });
});
