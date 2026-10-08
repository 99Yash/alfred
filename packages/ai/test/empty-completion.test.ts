import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { FinishReason } from "ai";

import { classifyStreamFinish, isRetryableEmptyCompletion } from "../src/agent";

/**
 * A fallback model can return a clean "stop" with no text and no tool calls. The SDK call succeeds,
 * so the executor retries it. Pins the finish-reason matrix both classifiers share;
 * content-filter and length empties must still surface, because a retry cannot clear them.
 */

// The classifier reads only `.length`.
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

// Keep the exit sets disjoint and total, so a new FinishReason cannot land in the wrong bucket.
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
