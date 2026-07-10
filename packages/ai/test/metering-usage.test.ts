import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { LanguageModelUsage } from "ai";
import { usageFromSdk, usageFromSteps } from "../src/metering/wrappers";

function sdkUsage(args: {
  input: number;
  output: number;
  read?: number;
  write?: number;
}): LanguageModelUsage {
  return {
    inputTokens: args.input,
    inputTokenDetails: {
      noCacheTokens: args.input - (args.read ?? 0) - (args.write ?? 0),
      cacheReadTokens: args.read,
      cacheWriteTokens: args.write,
    },
    outputTokens: args.output,
    outputTokenDetails: { textTokens: args.output, reasoningTokens: 0 },
    totalTokens: args.input + args.output,
  };
}

describe("metering usage extraction", () => {
  test("preserves distinct cache-read and cache-write usage", () => {
    assert.deepEqual(usageFromSdk(sdkUsage({ input: 100, output: 20, read: 30, write: 40 })), {
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 30,
      cacheWriteInputTokens: 40,
    });
  });

  test("keeps absent cache details undefined", () => {
    assert.deepEqual(usageFromSdk(sdkUsage({ input: 100, output: 20 })), {
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: undefined,
      cacheWriteInputTokens: undefined,
    });
  });

  test("aggregates partial usage from aborted stream steps", () => {
    assert.deepEqual(
      usageFromSteps([
        { usage: sdkUsage({ input: 100, output: 10, read: 25, write: 50 }) },
        { usage: sdkUsage({ input: 80, output: 5, read: 20, write: 10 }) },
      ]),
      {
        inputTokens: 180,
        outputTokens: 15,
        cachedInputTokens: 45,
        cacheWriteInputTokens: 60,
      },
    );
  });
});
