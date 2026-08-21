import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  batchForVoyage,
  VOYAGE_MAX_BATCH_INPUTS,
  VOYAGE_MAX_BATCH_TOKENS,
} from "../src/embeddings";

/** A text of `tokens` estimated tokens (4 chars per token, same as the batcher). */
function text(tokens: number): string {
  return "a".repeat(tokens * 4);
}

describe("batchForVoyage", () => {
  test("an empty input yields no batches", () => {
    assert.deepEqual(batchForVoyage([]), []);
  });

  test("input under both limits stays one batch", () => {
    const texts = [text(10), text(20), text(30)];
    assert.deepEqual(batchForVoyage(texts), [texts]);
  });

  test("splits when the token estimate exceeds the per-request budget", () => {
    const half = Math.floor(VOYAGE_MAX_BATCH_TOKENS / 2);
    const batches = batchForVoyage([text(half), text(half), text(half)]);
    assert.equal(batches.length, 2);
    assert.deepEqual(batches.flat(), [text(half), text(half), text(half)]);
    for (const batch of batches) {
      const tokens = batch.reduce((sum, t) => sum + t.length / 4, 0);
      assert.ok(tokens <= VOYAGE_MAX_BATCH_TOKENS);
    }
  });

  test("the exact token boundary does not split", () => {
    const half = VOYAGE_MAX_BATCH_TOKENS / 2;
    const texts = [text(half), text(half)];
    assert.deepEqual(batchForVoyage(texts), [texts]);
  });

  test("splits at the input-count limit", () => {
    const texts = Array.from({ length: VOYAGE_MAX_BATCH_INPUTS + 1 }, (_, i) => `t${i}`);
    const batches = batchForVoyage(texts);
    assert.equal(batches.length, 2);
    assert.equal(batches[0]!.length, VOYAGE_MAX_BATCH_INPUTS);
    assert.equal(batches[1]!.length, 1);
  });

  test("a single oversized text gets its own batch untouched", () => {
    const huge = text(VOYAGE_MAX_BATCH_TOKENS + 5_000);
    const small = text(10);
    const batches = batchForVoyage([huge, small]);
    assert.equal(batches.length, 2);
    assert.deepEqual(batches[0], [huge]);
    assert.deepEqual(batches[1], [small]);
  });

  test("never mutates its input", () => {
    const texts = [text(10), text(20)];
    const before = [...texts];
    batchForVoyage(texts);
    assert.deepEqual(texts, before);
  });
});
