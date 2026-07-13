import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { effectiveInputWindowTokens, requestFitsContextWindow } from "../src/context-window";

describe("context-window budget policy", () => {
  test("reserves output and fixed request overhead from input capacity", () => {
    assert.equal(
      effectiveInputWindowTokens({
        contextWindowTokens: 100_000,
        outputReserveTokens: 16_000,
        fixedInputOverheadTokens: 4_000,
      }),
      80_000,
    );
  });

  test("fit decisions include the boundary and reject one token over it", () => {
    const budget = { contextWindowTokens: 10_000, outputReserveTokens: 2_000 };
    assert.equal(requestFitsContextWindow(8_000, budget), true);
    assert.equal(requestFitsContextWindow(8_001, budget), false);
  });

  test("a reserve larger than the model window leaves no input capacity", () => {
    assert.equal(
      effectiveInputWindowTokens({ contextWindowTokens: 1_000, outputReserveTokens: 2_000 }),
      0,
    );
  });

  test("rejects invalid negative budgets and inputs", () => {
    assert.throws(
      () => effectiveInputWindowTokens({ contextWindowTokens: 1_000, outputReserveTokens: -1 }),
      /non-negative/,
    );
    assert.throws(
      () => requestFitsContextWindow(-1, { contextWindowTokens: 1_000 }),
      /non-negative/,
    );
  });
});
