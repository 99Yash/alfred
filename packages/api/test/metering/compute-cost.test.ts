import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { computeCost, type PriceLookup } from "@alfred/ai";

const PRICE: PriceLookup = {
  inputPerMtok: 3, // $3 / Mtok uncached input
  outputPerMtok: 15, // $15 / Mtok output
  cachedInputPerMtok: 0.3, // $0.30 / Mtok cache read
  cacheWriteInputPerMtok: 3.75, // $3.75 / Mtok cache write
  cacheWrite1hPerMtok: 6, // Anthropic 1h write = 2x input
  tiers: [],
  perCallUsd: null,
  contextWindow: 200_000,
};

describe("computeCost", () => {
  test("returns 0 with no price", () => {
    assert.equal(computeCost(null, { inputTokens: 1000, outputTokens: 10 }), 0);
  });

  test("uses a flat per-call price when set", () => {
    assert.equal(
      computeCost({ ...PRICE, perCallUsd: 0.05 }, { inputTokens: 1000, outputTokens: 10 }),
      0.05,
    );
  });

  test("bills uncached input at the input rate and output at the output rate", () => {
    // 1M input, 0.5M output, no cache
    const cost = computeCost(PRICE, {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
    });
    // 1*3 + 0.5*15 = 10.5
    assert.equal(cost, 10.5);
  });

  test("does NOT double-count cache reads: inputTokens already includes them", () => {
    // inputTokens is the TOTAL prompt (1M), of which 800k are cache reads.
    // Correct: 200k uncached @ $3 + 800k cached @ $0.30 = 0.6 + 0.24 = 0.84.
    const cost = computeCost(PRICE, {
      inputTokens: 1_000_000,
      cachedInputTokens: 800_000,
      outputTokens: 0,
    });
    assert.ok(
      Math.abs(cost - 0.84) < 1e-9,
      `expected ~0.84, got ${cost} (regression: cache reads double-counted)`,
    );
  });

  test("falls back to the input rate when no cached rate is configured", () => {
    const cost = computeCost(
      { ...PRICE, cachedInputPerMtok: null },
      { inputTokens: 1_000_000, cachedInputTokens: 800_000, outputTokens: 0 },
    );
    // 200k @ $3 + 800k @ $3 (fallback) = 1M @ $3 = 3
    assert.ok(Math.abs(cost - 3) < 1e-9, `expected ~3, got ${cost}`);
  });

  test("bills mixed uncached, cache-read, cache-write, and output usage exactly once", () => {
    const cost = computeCost(PRICE, {
      inputTokens: 1_000_000,
      cachedInputTokens: 300_000,
      cacheWriteInputTokens: 200_000,
      outputTokens: 100_000,
    });
    // 500k uncached @ $3 + 300k read @ $0.30 + 200k write @ $3.75 + 100k output @ $15
    assert.ok(Math.abs(cost - 3.84) < 1e-9, `expected ~3.84, got ${cost}`);
  });

  test("falls back to the input rate when no cache-write rate is configured", () => {
    const cost = computeCost(
      { ...PRICE, cacheWriteInputPerMtok: null },
      { inputTokens: 1_000_000, cacheWriteInputTokens: 800_000, outputTokens: 0 },
    );
    assert.ok(Math.abs(cost - 3) < 1e-9, `expected ~3, got ${cost}`);
  });

  test("charges GPT-5.6 Luna cache writes at 1.25x input", () => {
    const cost = computeCost(
      {
        ...PRICE,
        inputPerMtok: 1,
        outputPerMtok: 6,
        cachedInputPerMtok: 0.1,
        cacheWriteInputPerMtok: 1.25,
      },
      { inputTokens: 1_000_000, cacheWriteInputTokens: 1_000_000, outputTokens: 0 },
    );
    assert.equal(cost, 1.25);
  });

  test("uses the canonical no-cache detail when total input is unavailable", () => {
    const cost = computeCost(PRICE, {
      noCacheInputTokens: 200_000,
      cachedInputTokens: 800_000,
      outputTokens: 0,
    });
    assert.ok(Math.abs(cost - 0.84) < 1e-9, `expected ~0.84, got ${cost}`);
  });

  test("charges 1h Anthropic cache writes at the retention-specific rate", () => {
    const cost = computeCost(PRICE, {
      inputTokens: 1_000_000,
      noCacheInputTokens: 0,
      cacheWriteInputTokens: 1_000_000,
      cacheWriteTtl: "1h",
      outputTokens: 0,
    });
    assert.equal(cost, 6);
  });

  test("activates context-tier rates for long prompts", () => {
    const cost = computeCost(
      {
        ...PRICE,
        tiers: [
          {
            minInputTokens: 272_000,
            inputPerMtok: 10,
            outputPerMtok: 45,
            cachedInputPerMtok: 1,
            cacheWriteInputPerMtok: 12.5,
            cacheWrite1hPerMtok: null,
          },
        ],
      },
      { inputTokens: 500_000, noCacheInputTokens: 500_000, outputTokens: 100_000 },
    );
    assert.equal(cost, 9.5);
  });
});
