import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { COMPACTOR_FALLBACK_MODEL, COMPACTOR_MODEL } from "@alfred/ai";

import {
  chooseCompactorModel,
  compactorRequestOverheadTokens,
} from "../../src/modules/agent/compaction/compactor";

/**
 * #371: `chooseCompactorModel` picks the compaction model by asking "does the
 * request fit the window". The bug it locks was comparing a bare `prior`
 * estimate to the full window, ignoring the system prompt + payload wrapper +
 * reserved output tokens that ride along in the same request. A `prior` sized
 * just under the window then produced `prior + overhead > window` → a
 * deterministic provider 400 the workflow retries 3× and then fails on; the
 * opposite boundary silently routed near-window compactions to the full-price
 * fallback. These lock the reserved headroom.
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
      COMPACTOR_MODEL,
    );
  });

  test("a prior in the un-budgeted margin routes to fallback, not a 400 on the primary", () => {
    // Bare `prior` fits the window (`priorTokens < compactorWindow`) — the old
    // check would have picked the primary and 400'd. With headroom reserved,
    // `prior + overhead > compactorWindow`, so it correctly steps to fallback.
    const priorTokens = compactorWindow - 1;
    assert.ok(priorTokens < compactorWindow, "prior alone still fits the raw window");
    assert.ok(
      priorTokens + compactorRequestOverheadTokens > compactorWindow,
      "but the real request does not",
    );
    assert.equal(
      chooseCompactorModel({ priorTokens, compactorWindow, fallbackWindow }),
      COMPACTOR_FALLBACK_MODEL,
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
