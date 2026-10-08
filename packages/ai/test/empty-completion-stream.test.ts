import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  isStepCount,
  streamText,
  tool,
  type FinishReason,
  type LanguageModel,
  type ToolSet,
} from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

import { classifyStreamFinish } from "../src/agent";

/**
 * Proves the real `streamText` pipeline surfaces an empty candidate as a clean "stop" with no content.
 * Mirrors how `chat-turn.ts` drains the stream and calls `classifyStreamFinish`.
 * `withFallback` is out of scope: an empty stream is a successful call, not a throw.
 */

// From the mock, because `@ai-sdk/provider` is only a transitive dependency.
type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;

type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

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
// eslint-disable-next-line anti-slop/no-chained-type-assertions -- boundary cast: source type is structurally incompatible with target
const asModel = (m: MockLanguageModelV4) => m as unknown as LanguageModel;

// No `execute`, as in production, so the SDK surfaces the call without running it.
// SAFETY: under `exactOptionalPropertyTypes` a bare `Tool` is not assignable to `ToolSet[string]`.
const pingTools = {
  ping: tool({
    description: "test tool",
    inputSchema: z.object({ ok: z.boolean() }),
  }),
} as ToolSet;

async function driveStream(parts: StreamPart[]) {
  const model = new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-model",
    doStream: async () => ({ stream: convertArrayToReadableStream(parts) }),
  });

  const stream = streamText({
    model: asModel(model),
    prompt: "hi",
    tools: pingTools,
    // One model request, no SDK dispatch or retry, as in the agent.
    stopWhen: isStepCount(1),
    maxRetries: 0,
  });

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
    // The SDK call succeeds, so nothing upstream can catch it.
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
