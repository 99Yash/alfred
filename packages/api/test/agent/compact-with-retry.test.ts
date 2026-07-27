import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { CompactTranscriptResult } from "../../src/modules/agent/compaction/compactor";
import { compactWithRetry } from "../../src/modules/agent/compaction/compact-with-retry";

/**
 * A compactor call is full-price, so the retry loop's cost bound is a behavior
 * worth pinning: it must never spend an attempt on a turn the user has stopped.
 * `abortSignal` is a required option for exactly this reason — these tests are
 * what "required" is buying.
 */
describe("compactWithRetry cost bound", () => {
  const result: CompactTranscriptResult = {
    transcript: [{ role: "user", content: "compacted" }],
    summary: { role: "assistant", content: "summary" },
    raw: { text: "summary", inputTokens: 10, outputTokens: 5 },
  };

  test("retries a transient failure up to three attempts, then reports the last error", async () => {
    let attempts = 0;
    await assert.rejects(
      compactWithRetry(
        (attempt) => {
          attempts = attempt;
          return Promise.reject(new Error("provider blip"));
        },
        { abortSignal: "none" },
      ),
      /compactor_failed: provider blip/,
    );
    assert.equal(attempts, 3);
  });

  test("an abort during an attempt ends the loop on that attempt", async () => {
    const controller = new AbortController();
    let attempts = 0;
    await assert.rejects(
      compactWithRetry(
        (attempt) => {
          attempts = attempt;
          controller.abort();
          return Promise.reject(new Error("aborted mid-call"));
        },
        { abortSignal: controller.signal },
      ),
      /aborted mid-call/,
      "the underlying error surfaces, not a spent-budget error",
    );
    assert.equal(attempts, 1, "a stopped turn never buys a second compactor call");
  });

  test("an abort during the backoff window stops the next attempt", async () => {
    const controller = new AbortController();
    let attempts = 0;
    await assert.rejects(
      compactWithRetry(
        (attempt) => {
          attempts = attempt;
          return Promise.reject(new Error("provider blip"));
        },
        {
          abortSignal: controller.signal,
          // Stand in for the user hitting Stop while the loop is backing off.
          delayBeforeRetryMs: () => {
            controller.abort();
            return 1;
          },
        },
      ),
      /provider blip/,
    );
    assert.equal(attempts, 1, "the backoff window is not a hole in the cost bound");
  });

  test("the compactor refusing an oversized input is never retried", async () => {
    let attempts = 0;
    await assert.rejects(
      compactWithRetry(
        (attempt) => {
          attempts = attempt;
          return Promise.reject(new Error("compactor_input_too_large"));
        },
        { abortSignal: "none" },
      ),
      /compactor_input_too_large/,
    );
    assert.equal(attempts, 1, "the input does not shrink between attempts");
  });

  test("a success on a later attempt returns without further calls", async () => {
    let attempts = 0;
    const compacted = await compactWithRetry(
      (attempt) => {
        attempts = attempt;
        if (attempt === 1) return Promise.reject(new Error("provider blip"));
        return Promise.resolve(result);
      },
      { abortSignal: "none" },
    );
    assert.equal(attempts, 2);
    assert.equal(compacted, result, "the winning attempt's result is what comes back");
  });
});
