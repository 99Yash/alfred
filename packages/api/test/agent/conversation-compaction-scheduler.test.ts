import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  backgroundCompactionThresholdTokens,
  BACKGROUND_COMPACTION_ABSOLUTE_CAP_TOKENS,
} from "../../src/modules/agent/compaction";

describe("background conversation compaction threshold", () => {
  test("uses 60% of ordinary effective windows", () => {
    assert.equal(backgroundCompactionThresholdTokens(100_000), 60_000);
  });

  test("caps large model windows at 200K", () => {
    assert.equal(
      backgroundCompactionThresholdTokens(1_000_000),
      BACKGROUND_COMPACTION_ABSOLUTE_CAP_TOKENS,
    );
  });

  test("rejects invalid windows", () => {
    assert.throws(() => backgroundCompactionThresholdTokens(-1), /non-negative/);
  });
});
