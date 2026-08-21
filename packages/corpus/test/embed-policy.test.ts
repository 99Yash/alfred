import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Chunk } from "../src/chunker";
import { capChunksForBudget, EMBED_COST_CAP_USD, maxTokensForPrice } from "../src/embed-policy";

function chunk(tokens: number, position: number): Chunk {
  return { position, content: `chunk-${position}`.repeat(Math.max(1, tokens)), tokenCount: tokens };
}

describe("maxTokensForPrice", () => {
  test("converts the Voyage price into the token budget the $0.50 cap buys", () => {
    assert.equal(maxTokensForPrice(0.06), 8_333_333);
  });

  test("is the floored cap/price ratio in million-token units", () => {
    assert.equal(maxTokensForPrice(1), 500_000);
    assert.equal(maxTokensForPrice(0.5), 1_000_000);
  });

  test("a higher price buys fewer tokens", () => {
    assert.ok(maxTokensForPrice(0.12) < maxTokensForPrice(0.06));
  });
});

describe("capChunksForBudget", () => {
  test("returns copies, not the inputs, when everything fits", () => {
    const chunks = [chunk(10, 0), chunk(20, 1)];
    const hashes = ["h0", "h1"];
    const result = capChunksForBudget(chunks, hashes, 30);
    assert.equal(result.truncated, false);
    assert.equal(result.kept, 2);
    assert.equal(result.total, 30);
    assert.notEqual(result.chunks, chunks);
    assert.notEqual(result.hashes, hashes);
    assert.deepEqual(result.chunks, chunks);
    assert.deepEqual(result.hashes, hashes);
  });

  test("the exact budget boundary is not a truncation", () => {
    const result = capChunksForBudget([chunk(10, 0), chunk(20, 1)], ["h0", "h1"], 30);
    assert.equal(result.truncated, false);
    assert.equal(result.kept, 2);
  });

  test("keeps the longest fitting prefix and slices hashes in lockstep", () => {
    const chunks = [chunk(3, 0), chunk(3, 1), chunk(3, 2)];
    const hashes = ["h0", "h1", "h2"];
    const result = capChunksForBudget(chunks, hashes, 7);
    assert.equal(result.truncated, true);
    assert.equal(result.kept, 2);
    assert.deepEqual(
      result.chunks.map((c) => c.position),
      [0, 1],
    );
    assert.deepEqual(result.hashes, ["h0", "h1"]);
    assert.equal(result.total, 9, "total counts all input tokens, before capping");
  });

  test("an oversized first chunk yields an empty, truncated slice", () => {
    const chunks = [chunk(10, 0), chunk(1, 1)];
    const result = capChunksForBudget(chunks, ["h0", "h1"], 5);
    assert.equal(result.truncated, true);
    assert.equal(result.kept, 0);
    assert.deepEqual(result.chunks, []);
    assert.deepEqual(result.hashes, []);
  });

  test("never mutates its inputs", () => {
    const chunks = [chunk(3, 0), chunk(3, 1), chunk(3, 2)];
    const hashes = ["h0", "h1", "h2"];
    const chunksBefore = structuredClone(chunks);
    const hashesBefore = [...hashes];
    capChunksForBudget(chunks, hashes, 4);
    assert.deepEqual(chunks, chunksBefore);
    assert.deepEqual(hashes, hashesBefore);
  });

  test("the shipped cap is the documented $0.50", () => {
    assert.equal(EMBED_COST_CAP_USD, 0.5);
  });
});
