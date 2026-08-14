import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { foldModelUsage, type ModelUsageGroup } from "@alfred/assistant/execution/usage-fold";

/** Postgres hands back `sum`/`count` as strings; the fixtures keep that shape. */
const group = (over: Partial<ModelUsageGroup>): ModelUsageGroup => ({
  model: "claude-sonnet-4-6",
  subId: null,
  inputTokens: "0",
  outputTokens: "0",
  cachedInputTokens: "0",
  costUsd: "0",
  calls: "0",
  ...over,
});

describe("foldModelUsage", () => {
  test("sums the turn across boss and sub-agent groups", () => {
    const usage = foldModelUsage([
      group({ subId: null, inputTokens: "100", outputTokens: "20", costUsd: "0.10", calls: "2" }),
      group({
        subId: "research",
        inputTokens: "900",
        outputTokens: "80",
        costUsd: "0.40",
        calls: "6",
      }),
    ]);

    assert.equal(usage.inputTokens, 1000);
    assert.equal(usage.outputTokens, 100);
    assert.equal(usage.calls, 8);
    assert.ok(Math.abs(usage.costUsd - 0.5) < 1e-9);
  });

  test("splits cost per agent, most expensive first, boss as null", () => {
    const usage = foldModelUsage([
      group({ subId: "cheap", costUsd: "0.01", calls: "1" }),
      group({ subId: null, costUsd: "0.10", calls: "3" }),
      group({ subId: "research", costUsd: "0.40", calls: "6" }),
    ]);

    assert.deepEqual(usage.agents, [
      { subId: "research", calls: 6, costUsd: 0.4 },
      { subId: null, calls: 3, costUsd: 0.1 },
      { subId: "cheap", calls: 1, costUsd: 0.01 },
    ]);
  });

  test("re-buckets both breakdowns: one model can serve two agents and back", () => {
    // The caller groups by (agent, model), so the same model appears under two
    // agents and the same agent under two models. Neither breakdown may double
    // count.
    const usage = foldModelUsage([
      group({ subId: null, model: "claude-sonnet-4-6", costUsd: "0.10", calls: "3" }),
      group({ subId: null, model: "gemini-2.5-flash", costUsd: "0.01", calls: "1" }),
      group({ subId: "research", model: "claude-sonnet-4-6", costUsd: "0.40", calls: "5" }),
    ]);

    assert.deepEqual(usage.models, [
      { model: "claude-sonnet-4-6", calls: 8 },
      { model: "gemini-2.5-flash", calls: 1 },
    ]);
    assert.deepEqual(usage.agents, [
      { subId: "research", calls: 5, costUsd: 0.4 },
      { subId: null, calls: 4, costUsd: 0.11 },
    ]);
    assert.equal(usage.calls, 9);
  });

  test("treats unreadable aggregates as zero rather than NaN", () => {
    const usage = foldModelUsage([
      group({
        subId: null,
        inputTokens: "",
        outputTokens: "not-a-number",
        costUsd: "0.02",
        calls: "1",
      }),
    ]);

    assert.equal(usage.inputTokens, 0);
    assert.equal(usage.outputTokens, 0);
    assert.deepEqual(usage.agents, [{ subId: null, calls: 1, costUsd: 0.02 }]);
  });

  test("returns an empty rollup for no groups", () => {
    const usage = foldModelUsage([]);

    assert.equal(usage.calls, 0);
    assert.deepEqual(usage.models, []);
    assert.deepEqual(usage.agents, []);
  });
});
