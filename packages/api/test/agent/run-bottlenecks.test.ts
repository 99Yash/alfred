import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  summarizeRunBottlenecks,
  type RunBottleneckInput,
} from "../../src/modules/agent/run-bottlenecks";

// Fixed epoch so every duration in the fixtures is exact and readable.
const t = (ms: number): Date => new Date(ms);

describe("summarizeRunBottlenecks", () => {
  test("splits wall-clock into model / tool / approval / sub-agent / queue buckets", () => {
    // Timeline (ms): boss[0-1000] →queue 500→ dispatch(parked)[1500-2000]
    //   →approval wait 3000→ boss[5000-5500] →queue 300→ dispatch(parked)[5800-6300]
    //   →sub-agent wait 2700→ boss[9000-9500] →queue 100→ dispatch(reclaimed,failed)[9600-9700]
    const input: RunBottleneckInput = {
      run: { startedAt: t(0), endedAt: t(20_000) },
      apiCalls: [
        { latencyMs: 1000, inputTokens: 100, outputTokens: 20, costUsd: "1.5" },
        { latencyMs: 2000, inputTokens: 200, outputTokens: 40, costUsd: "2.5" },
      ],
      steps: [
        { stepId: "boss-turn", status: "completed", startedAt: t(0), endedAt: t(1000), errorReason: null },
        { stepId: "dispatch-tools", status: "interrupted", startedAt: t(1500), endedAt: t(2000), errorReason: null },
        { stepId: "boss-turn", status: "completed", startedAt: t(5000), endedAt: t(5500), errorReason: null },
        { stepId: "dispatch-tools", status: "interrupted", startedAt: t(5800), endedAt: t(6300), errorReason: null },
        { stepId: "boss-turn", status: "completed", startedAt: t(9000), endedAt: t(9500), errorReason: null },
        { stepId: "dispatch-tools", status: "failed", startedAt: t(9600), endedAt: t(9700), errorReason: "lease_reclaimed" },
      ],
      stagings: [
        { status: "approved", createdAt: t(2000), decidedAt: t(4000) },
        { status: "rejected", createdAt: t(6300), decidedAt: t(6300) },
        { status: "expired", createdAt: t(100), decidedAt: t(100) },
      ],
    };

    const summary = summarizeRunBottlenecks(input);

    assert.equal(summary.wallClockMs, 20_000);
    // api_call_log sums.
    assert.equal(summary.modelMs, 3000);
    assert.equal(summary.inputTokens, 300);
    assert.equal(summary.outputTokens, 60);
    assert.equal(summary.costUsd, 4);
    // Only the two parked/completed dispatch-tools steps (500 + 500); the
    // reclaimed/failed one is excluded.
    assert.equal(summary.toolMs, 1000);
    // Approval wait is precise from the staging (4000 - 2000).
    assert.equal(summary.approvalWaitMs, 2000);
    // Wait gaps follow the two interrupted steps: 3000 + 2700 = 5700; minus the
    // 2000 explained by the approval = 3700 attributed to sub-agent joins.
    assert.equal(summary.subAgentWaitMs, 3700);
    // Queue is the gaps after non-parked steps: 500 + 300 + 100 = 900.
    assert.equal(summary.queueMs, 900);
    assert.equal(summary.reclaims, 1);
    assert.equal(summary.stagingsRejected, 1);
    assert.equal(summary.stagingsExpired, 1);
  });

  test("queue time excludes attributed approval and sub-agent waits", () => {
    // One approval-parked gap and one sub-agent-parked gap, bracketed by queue
    // gaps after completed steps. queue must not absorb either wait.
    const input: RunBottleneckInput = {
      run: { startedAt: t(0), endedAt: t(10_000) },
      apiCalls: [],
      steps: [
        { stepId: "boss-turn", status: "completed", startedAt: t(0), endedAt: t(100), errorReason: null },
        // gap 200 (queue, after completed)
        { stepId: "dispatch-tools", status: "interrupted", startedAt: t(300), endedAt: t(400), errorReason: null },
        // gap 1000 (wait, after interrupted) — matched by the approval below
        { stepId: "boss-turn", status: "completed", startedAt: t(1400), endedAt: t(1500), errorReason: null },
        // gap 50 (queue, after completed)
        { stepId: "dispatch-tools", status: "interrupted", startedAt: t(1550), endedAt: t(1600), errorReason: null },
        // gap 5000 (wait, after interrupted) — no staging → sub-agent
        { stepId: "boss-turn", status: "completed", startedAt: t(6600), endedAt: t(6700), errorReason: null },
      ],
      stagings: [{ status: "approved", createdAt: t(400), decidedAt: t(1400) }],
    };

    const summary = summarizeRunBottlenecks(input);

    assert.equal(summary.approvalWaitMs, 1000);
    assert.equal(summary.subAgentWaitMs, 5000);
    assert.equal(summary.queueMs, 250); // 200 + 50, never the 1000 or 5000 waits
  });

  test("orders steps by start time before computing gaps", () => {
    // Same two steps, supplied out of order — the gap must be 900, not negative.
    const input: RunBottleneckInput = {
      run: { startedAt: t(0), endedAt: t(2000) },
      apiCalls: [],
      steps: [
        { stepId: "boss-turn", status: "completed", startedAt: t(1000), endedAt: t(1100), errorReason: null },
        { stepId: "boss-turn", status: "completed", startedAt: t(0), endedAt: t(100), errorReason: null },
      ],
      stagings: [],
    };
    const summary = summarizeRunBottlenecks(input);
    assert.equal(summary.queueMs, 900); // 1000 - 100
  });

  test("wallClockMs is null until the run has both started and ended", () => {
    const running = summarizeRunBottlenecks({
      run: { startedAt: t(0), endedAt: null },
      apiCalls: [],
      steps: [],
      stagings: [],
    });
    assert.equal(running.wallClockMs, null);

    const empty = summarizeRunBottlenecks({
      run: { startedAt: null, endedAt: null },
      apiCalls: [],
      steps: [],
      stagings: [],
    });
    assert.equal(empty.wallClockMs, null);
    assert.equal(empty.modelMs, 0);
    assert.equal(empty.queueMs, 0);
  });

  test("tolerates null token / cost / latency columns", () => {
    const summary = summarizeRunBottlenecks({
      run: { startedAt: t(0), endedAt: t(500) },
      apiCalls: [
        { latencyMs: null, inputTokens: null, outputTokens: null, costUsd: null },
        { latencyMs: 250, inputTokens: 10, outputTokens: 5, costUsd: 0.25 },
      ],
      steps: [],
      stagings: [],
    });
    assert.equal(summary.modelMs, 250);
    assert.equal(summary.inputTokens, 10);
    assert.equal(summary.outputTokens, 5);
    assert.equal(summary.costUsd, 0.25);
  });
});
