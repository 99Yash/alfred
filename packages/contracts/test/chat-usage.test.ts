import assert from "node:assert/strict";
import { test } from "node:test";

import { chatMessageUsageSchema } from "../src/chat";

test("chat usage defaults model latency for durable legacy messages", () => {
  const usage = chatMessageUsageSchema.parse({
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 80,
    costUsd: 0.01,
    calls: 1,
  });

  assert.equal(usage.modelLatencyMs, 0);
});
