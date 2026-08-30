import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { outputTokensPerSecond } from "../src/lib/usage-format";

describe("outputTokensPerSecond", () => {
  test("divides output tokens by model-call seconds", () => {
    assert.equal(outputTokensPerSecond(50, 5_000), 10);
  });

  test("omits throughput without output or a measured duration", () => {
    assert.equal(outputTokensPerSecond(0, 5_000), null);
    assert.equal(outputTokensPerSecond(50, 0), null);
  });
});
