import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { APICallError, generateText } from "ai";
import type { LanguageModel } from "ai-retry";
import { MockLanguageModelV4 } from "ai/test";

import { withFallback } from "../src/provider";

// From the mock, because `@ai-sdk/provider` is only a transitive dependency.
type GenResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;

/**
 * A non-retryable 4xx is our own bad request, so it must surface, not fall back (regression: #224).
 * Every mock sets `isRetryable: false`, so only our `shouldSwitch` predicate decides.
 */

const TEXT_FALLBACK = "served-by-fallback";

const TEXT_PRIMARY = "served-by-primary";

function okResult(text: string): GenResult {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    },
    warnings: [],
  };
}

function apiError(
  statusCode: number,
  message = `mock ${statusCode}`,
  responseBody?: string,
): APICallError {
  return new APICallError({
    message,
    url: "https://mock.invalid/v1",
    requestBodyValues: {},
    statusCode,
    isRetryable: false,
    // `responseBody?: string` rejects a present `undefined`.
    ...(responseBody === undefined ? {} : { responseBody }),
  });
}

function throwingModel(modelId: string, err: unknown): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId,
    doGenerate: async () => {
      throw err;
    },
  });
}

function okModel(modelId: string, text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId,
    doGenerate: async () => okResult(text),
  });
}

// Same spec, but `ai-retry` names its own `LanguageModel` type.
// eslint-disable-next-line anti-slop/no-chained-type-assertions -- boundary cast: source type is structurally incompatible with target
const asModel = (m: MockLanguageModelV4) => m as unknown as LanguageModel;

async function run(primary: MockLanguageModelV4, fallback: MockLanguageModelV4) {
  return generateText({
    model: withFallback(asModel(primary), asModel(fallback)),
    prompt: "hi",
    // Remove the SDK's outer retry so only `withFallback` acts.
    maxRetries: 0,
  });
}

describe("withFallback", () => {
  for (const code of [400, 401, 403, 404, 422]) {
    test(`${code} client bug surfaces and never touches the fallback`, async () => {
      const primary = throwingModel("primary", apiError(code));
      const fallback = okModel("fallback", TEXT_FALLBACK);

      await assert.rejects(run(primary, fallback), (err: unknown) => {
        assert.ok(APICallError.isInstance(err), "expected the raw APICallError");
        assert.equal(err.statusCode, code);

        return true;
      });

      assert.equal(fallback.doGenerateCalls.length, 0, "fallback must not run on a client bug");
    });
  }

  // 408/429 are not client bugs; 5xx means the provider is down.
  for (const code of [408, 429, 500, 502, 503]) {
    test(`${code} degrades to the fallback`, async () => {
      const primary = throwingModel("primary", apiError(code));
      const fallback = okModel("fallback", TEXT_FALLBACK);

      const { text } = await run(primary, fallback);

      assert.equal(text, TEXT_FALLBACK);
      assert.equal(fallback.doGenerateCalls.length, 1);
    });
  }

  // Billing and quota 4xx are capacity limits, not bad requests (regression: #303).
  const quotaErrors = [
    apiError(400, "You have reached your specified workspace API usage limits."),
    apiError(400, "Your credit balance is too low to access the Anthropic API."),
    apiError(
      400,
      "Request failed",
      JSON.stringify({
        type: "error",
        error: { type: "billing_error", message: "usage limit reached" },
      }),
    ),
  ];

  for (const [i, err] of quotaErrors.entries()) {
    test(`billing/quota 4xx (#${i}) degrades to the fallback`, async () => {
      const primary = throwingModel("primary", err);
      const fallback = okModel("fallback", TEXT_FALLBACK);

      const { text } = await run(primary, fallback);

      assert.equal(text, TEXT_FALLBACK);
      assert.equal(fallback.doGenerateCalls.length, 1);
    });
  }

  test("a non-APICallError degrades to the fallback", async () => {
    const primary = throwingModel("primary", new Error("socket hang up"));
    const fallback = okModel("fallback", TEXT_FALLBACK);

    const { text } = await run(primary, fallback);

    assert.equal(text, TEXT_FALLBACK);
    assert.equal(fallback.doGenerateCalls.length, 1);
  });

  // The hedged classify aborts its losing duplicate; that cancel must not bill a fallback call.
  test("a caller abort surfaces and never touches the fallback", async () => {
    const primary = throwingModel("primary", new DOMException("cancelled", "AbortError"));
    const fallback = okModel("fallback", TEXT_FALLBACK);

    await assert.rejects(run(primary, fallback), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.name, "AbortError");

      return true;
    });

    assert.equal(fallback.doGenerateCalls.length, 0, "fallback must not run on a caller abort");
  });

  // Only the classification. With `timeout: { totalMs }`, all attempts share one abort signal,
  // so an expired budget also aborts the fallback. This mock throws while the signal is live.
  test("a timeout is classified as switch-worthy, not as a cancel", async () => {
    const primary = throwingModel(
      "primary",
      new DOMException("timeout of 30000ms exceeded", "TimeoutError"),
    );

    const fallback = okModel("fallback", TEXT_FALLBACK);

    const { text } = await run(primary, fallback);

    assert.equal(text, TEXT_FALLBACK);
    assert.equal(fallback.doGenerateCalls.length, 1);
  });

  test("a healthy primary serves and never touches the fallback", async () => {
    const primary = okModel("primary", TEXT_PRIMARY);
    const fallback = okModel("fallback", TEXT_FALLBACK);

    const { text } = await run(primary, fallback);

    assert.equal(text, TEXT_PRIMARY);
    assert.equal(fallback.doGenerateCalls.length, 0);
  });
});
