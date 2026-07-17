import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { FinishReason } from "ai";

import { classifyStreamFinish, isRetryableEmptyCompletion } from "../src/agent";

/**
 * The empty-completion contract (2026-07-10 chat-turn dig). When Anthropic hits
 * its workspace spend cap, `withFallback` degrades the boss to Gemini 3.5 Flash,
 * which occasionally returns a `finishReason:stop` candidate with **0 output
 * tokens** — no text, no tool calls. `withFallback` cannot catch it (the SDK
 * call *succeeds* with an empty stream), so the executor treats it as a bounded,
 * retryable anomaly instead of dead-ending the turn.
 *
 * `isRetryableEmptyCompletion` owns the retryable-vs-surface decision; both the
 * streaming (`classifyStreamFinish`) and non-streaming (`classifyTurnResult`)
 * classifiers delegate to it. These tests pin the finish-reason matrix so the
 * two never diverge and a content-filter/length empty (which a retry can't
 * clear) keeps surfacing.
 */

// A single fake tool call — the classifier only reads `.length`, so the shape
// past that is irrelevant.
const ONE_TOOL_CALL = [{}];
const NO_TOOL_CALLS: unknown[] = [];

describe("isRetryableEmptyCompletion", () => {
  test("empty + clean stop → retryable", () => {
    assert.equal(
      isRetryableEmptyCompletion({ finishReason: "stop", hasToolCalls: false, textLength: 0 }),
      true,
    );
  });

  test("empty + provider error → retryable", () => {
    assert.equal(
      isRetryableEmptyCompletion({ finishReason: "error", hasToolCalls: false, textLength: 0 }),
      true,
    );
  });

  test("empty + other finish → retryable", () => {
    assert.equal(
      isRetryableEmptyCompletion({ finishReason: "other", hasToolCalls: false, textLength: 0 }),
      true,
    );
  });

  test("empty + content-filter → NOT retryable (safety block won't self-heal)", () => {
    assert.equal(
      isRetryableEmptyCompletion({
        finishReason: "content-filter",
        hasToolCalls: false,
        textLength: 0,
      }),
      false,
    );
  });

  test("empty + length → NOT retryable (budget exhausted won't self-heal)", () => {
    assert.equal(
      isRetryableEmptyCompletion({ finishReason: "length", hasToolCalls: false, textLength: 0 }),
      false,
    );
  });

  test("has text → never empty, whatever the finish reason", () => {
    assert.equal(
      isRetryableEmptyCompletion({ finishReason: "stop", hasToolCalls: false, textLength: 12 }),
      false,
    );
  });

  test("has tool calls → never empty (it did something)", () => {
    assert.equal(
      isRetryableEmptyCompletion({ finishReason: "stop", hasToolCalls: true, textLength: 0 }),
      false,
    );
  });
});

describe("classifyStreamFinish", () => {
  test("tool calls present → tool-calls (even with no text)", () => {
    assert.deepEqual(
      classifyStreamFinish({ toolCalls: ONE_TOOL_CALL, finishReason: "tool-calls", textLength: 0 }),
      { kind: "tool-calls" },
    );
  });

  test("empty stop with no tool calls → empty (retryable)", () => {
    assert.deepEqual(
      classifyStreamFinish({ toolCalls: NO_TOOL_CALLS, finishReason: "stop", textLength: 0 }),
      { kind: "empty" },
    );
  });

  test("empty error with no tool calls → empty (retryable)", () => {
    assert.deepEqual(
      classifyStreamFinish({ toolCalls: NO_TOOL_CALLS, finishReason: "error", textLength: 0 }),
      { kind: "empty" },
    );
  });

  test("stop with text → final", () => {
    assert.deepEqual(
      classifyStreamFinish({ toolCalls: NO_TOOL_CALLS, finishReason: "stop", textLength: 42 }),
      { kind: "final" },
    );
  });

  test("empty content-filter → stopped (surfaces, not retried)", () => {
    assert.deepEqual(
      classifyStreamFinish({
        toolCalls: NO_TOOL_CALLS,
        finishReason: "content-filter",
        textLength: 0,
      }),
      { kind: "stopped", reason: "content-filter" },
    );
  });

  test("empty length → stopped (surfaces, not retried)", () => {
    assert.deepEqual(
      classifyStreamFinish({ toolCalls: NO_TOOL_CALLS, finishReason: "length", textLength: 0 }),
      { kind: "stopped", reason: "length" },
    );
  });

  test("errored finish WITH text → stopped:error (a real fault, not an empty)", () => {
    assert.deepEqual(
      classifyStreamFinish({ toolCalls: NO_TOOL_CALLS, finishReason: "error", textLength: 7 }),
      { kind: "stopped", reason: "error" },
    );
  });
});

// Exhaustive guard: keep the two exit sets disjoint and total over the finish
// reasons we handle, so a future FinishReason literal doesn't silently fall into
// the wrong bucket.
describe("classifyStreamFinish finish-reason coverage", () => {
  const reasons: FinishReason[] = [
    "stop",
    "length",
    "content-filter",
    "tool-calls",
    "error",
    "other",
  ];
  test("no-text, no-tool-calls turns split cleanly into empty vs stopped", () => {
    for (const finishReason of reasons) {
      const outcome = classifyStreamFinish({
        toolCalls: NO_TOOL_CALLS,
        finishReason,
        textLength: 0,
      });
      if (finishReason === "content-filter" || finishReason === "length") {
        assert.equal(outcome.kind, "stopped", `${finishReason} should surface`);
      } else {
        assert.equal(outcome.kind, "empty", `${finishReason} should retry`);
      }
    }
  });
});
