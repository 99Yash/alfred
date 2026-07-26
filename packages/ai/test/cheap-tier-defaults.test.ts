import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { generateText } from "ai";
import type { LanguageModel } from "ai-retry";
import { MockLanguageModelV4 } from "ai/test";

import { withCheapTierDefaults } from "../src/provider";

/**
 * The cheap tier must never buy a reasoning budget (#436).
 *
 * `gemini-2.5-flash-lite` defaults thinking off, but its `withFallback` partner
 * `gemini-2.5-flash` defaults to *dynamic* thinking — so every degraded cheap
 * call (triage classify, memory extraction, …) burned reasoning tokens on a
 * short structured extraction. `withCheapTierDefaults` pins
 * `thinkingConfig.thinkingBudget: 0` as a **default**, which means a caller that
 * deliberately asks for thinking still wins the merge. Both halves of that
 * contract are load-bearing, so both are pinned here.
 */

type GenResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;

function okResult(): GenResult {
  return {
    content: [{ type: "text" as const, text: "ok" }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    },
    warnings: [],
  };
}

function mockModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "google",
    modelId: "gemini-2.5-flash-lite",
    doGenerate: async () => okResult(),
  });
}

const asModel = (m: MockLanguageModelV4) => m as unknown as LanguageModel;

/** The `google` provider options the wrapped model actually dispatched. */
function dispatchedGoogleOptions(model: MockLanguageModelV4): Record<string, unknown> {
  const call = model.doGenerateCalls[0];
  assert.ok(call, "expected the wrapped model to dispatch exactly one call");
  const google = call.providerOptions?.google;
  assert.ok(google, "expected google-namespaced provider options on the dispatched call");
  return google;
}

describe("withCheapTierDefaults", () => {
  test("injects thinkingBudget: 0 when the caller passes no provider options", async () => {
    const inner = mockModel();

    await generateText({ model: withCheapTierDefaults(asModel(inner)), prompt: "hi" });

    assert.deepEqual(dispatchedGoogleOptions(inner), { thinkingConfig: { thinkingBudget: 0 } });
  });

  test("an explicit caller thinkingBudget wins the merge", async () => {
    const inner = mockModel();

    await generateText({
      model: withCheapTierDefaults(asModel(inner)),
      prompt: "hi",
      providerOptions: { google: { thinkingConfig: { thinkingBudget: -1 } } },
    });

    assert.deepEqual(dispatchedGoogleOptions(inner), { thinkingConfig: { thinkingBudget: -1 } });
  });

  test("caller options in other namespaces survive alongside the default", async () => {
    const inner = mockModel();

    await generateText({
      model: withCheapTierDefaults(asModel(inner)),
      prompt: "hi",
      providerOptions: { anthropic: { effort: "low" } },
    });

    const call = inner.doGenerateCalls[0];
    assert.ok(call);
    assert.deepEqual(call.providerOptions, {
      anthropic: { effort: "low" },
      google: { thinkingConfig: { thinkingBudget: 0 } },
    });
  });

  test("provider and modelId proxy through, so cost attribution is unchanged", () => {
    const wrapped = withCheapTierDefaults(asModel(mockModel()));

    assert.equal(typeof wrapped, "object");
    assert.ok(typeof wrapped === "object");
    assert.equal(wrapped.provider, "google");
    assert.equal(wrapped.modelId, "gemini-2.5-flash-lite");
  });
});
