import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { route } from "@alfred/ai";

import {
  chooseCompactorModel,
  compactorRequestOverheadTokens,
} from "@alfred/assistant/execution/run-compaction/compactor";

/**
 * `chooseCompactorModel` must count the system prompt, wrapper, and reserved
 * output with `prior`. A bare `prior` just under the window gets a provider 400.
 */
describe("chooseCompactorModel headroom (#371)", () => {
  const compactorWindow = 200_000;
  const fallbackWindow = 1_000_000;

  test("reserves the request overhead before comparing to the window", () => {
    assert.ok(
      compactorRequestOverheadTokens > 2000,
      "overhead must cover at least the 2000-token output reservation",
    );
  });

  test("a prior that fits with headroom stays on the primary compactor", () => {
    const priorTokens = compactorWindow - compactorRequestOverheadTokens - 1;
    assert.equal(
      chooseCompactorModel({ priorTokens, compactorWindow, fallbackWindow }),
      route("compactor").model(),
    );
  });

  test("a prior in the un-budgeted margin routes to fallback, not a 400 on the primary", () => {
    // `prior` alone fits, but `prior + overhead` does not.
    const priorTokens = compactorWindow - 1;
    assert.ok(priorTokens < compactorWindow, "prior alone still fits the raw window");
    assert.ok(
      priorTokens + compactorRequestOverheadTokens > compactorWindow,
      "but the real request does not",
    );
    assert.equal(
      chooseCompactorModel({ priorTokens, compactorWindow, fallbackWindow }),
      route("compactorFallback").model(),
    );
  });

  test("a prior exceeding even the fallback window (with headroom) throws", () => {
    const priorTokens = fallbackWindow - Math.floor(compactorRequestOverheadTokens / 2);
    assert.throws(
      () => chooseCompactorModel({ priorTokens, compactorWindow, fallbackWindow }),
      /compactor_input_too_large/,
    );
  });
});
