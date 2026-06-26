import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { APICallError, generateText } from "ai";
import type { LanguageModel } from "ai-retry";
import { MockLanguageModelV3 } from "ai/test";

import { withFallback } from "../src/provider";

// Derive the generate-result shape from the mock itself (same `ai` copy) rather
// than importing `@ai-sdk/provider`, which is only a transitive dependency.
type GenResult = Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>>;

/**
 * `withFallback` degrades a failed primary call to a fallback model — EXCEPT a
 * non-retryable 4xx, which means our own request is malformed (an illegal tool
 * name, an unsupported provider option) rather than the provider being down.
 * Switching providers on a client bug just hides it behind a weaker model:
 * that is exactly how the dotted-tool-name 400 ran the chat boss on Gemini for
 * weeks, and how the Opus-4.8 `thinking` 400 silently degraded every Deep turn
 * (#224). This file pins that contract so the next 4xx surfaces loudly.
 *
 * The classification we own lives in `withFallback`'s second retryable
 * (`shouldSwitch`) — rule 1 (retry the primary on a provider-flagged retryable
 * error) is stock `ai-retry`. To exercise our predicate in isolation, every
 * mocked error sets `isRetryable: false`, so rule 1 always skips and rule 2
 * alone decides switch-vs-surface. (A real 429 is provider-flagged retryable
 * and would loop through rule 1 first; here we test only how the status code is
 * *classified*, which is the bug-prone part.)
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

function apiError(statusCode: number, message = `mock ${statusCode}`, responseBody?: string): APICallError {
  return new APICallError({
    message,
    url: "https://mock.invalid/v1",
    requestBodyValues: {},
    statusCode,
    isRetryable: false,
    responseBody,
  });
}

function throwingModel(modelId: string, err: unknown): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: "mock",
    modelId,
    doGenerate: async () => {
      throw err;
    },
  });
}

function okModel(modelId: string, text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: "mock",
    modelId,
    doGenerate: async () => okResult(text),
  });
}

// MockLanguageModelV3 implements the ai-sdk LanguageModelV3; `withFallback`'s
// params are `ai-retry`'s `LanguageModel` alias for the same spec.
const asModel = (m: MockLanguageModelV3) => m as unknown as LanguageModel;

async function run(primary: MockLanguageModelV3, fallback: MockLanguageModelV3) {
  return generateText({
    model: withFallback(asModel(primary), asModel(fallback)),
    prompt: "hi",
    // Strip the SDK's own outer retry so the assertions are purely about
    // `withFallback`'s cascade.
    maxRetries: 0,
  });
}

describe("withFallback", () => {
  // A non-retryable 4xx is our own malformed request: surface it, never degrade.
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

  // 408/429 are excluded from the client-bug carve-out (a legit reason to try
  // the other provider); 5xx is the provider being down. All degrade.
  for (const code of [408, 429, 500, 502, 503]) {
    test(`${code} degrades to the fallback`, async () => {
      const primary = throwingModel("primary", apiError(code));
      const fallback = okModel("fallback", TEXT_FALLBACK);

      const { text } = await run(primary, fallback);

      assert.equal(text, TEXT_FALLBACK);
      assert.equal(fallback.doGenerateCalls.length, 1);
    });
  }

  // A billing/quota condition (workspace spend cap, exhausted credits) arrives
  // as a 4xx that is NOT 408/429, but it is a *capacity* condition we want to
  // degrade through — not a malformed request. #303: Anthropic's workspace
  // spend cap hard-failed the turn at attempt 0 because the generic client-bug
  // guard surfaced it. These must reach the fallback.
  const quotaErrors = [
    apiError(400, "You have reached your specified workspace API usage limits."),
    apiError(400, "Your credit balance is too low to access the Anthropic API."),
    apiError(
      400,
      "Request failed",
      JSON.stringify({ type: "error", error: { type: "billing_error", message: "usage limit reached" } }),
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

  test("a healthy primary serves and never touches the fallback", async () => {
    const primary = okModel("primary", TEXT_PRIMARY);
    const fallback = okModel("fallback", TEXT_FALLBACK);

    const { text } = await run(primary, fallback);

    assert.equal(text, TEXT_PRIMARY);
    assert.equal(fallback.doGenerateCalls.length, 0);
  });
});
