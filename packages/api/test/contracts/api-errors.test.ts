import assert from "node:assert/strict";
import test from "node:test";
import { apiErrorMessage, isApiErrorResponse } from "@alfred/contracts";

test("isApiErrorResponse accepts only the canonical API error body shape", () => {
  assert.equal(isApiErrorResponse({ error: "bad", code: "BAD_REQUEST" }), true);
  assert.equal(isApiErrorResponse({ error: "bad", code: "NOPE" }), false);
  assert.equal(isApiErrorResponse({ error: "bad", code: "BAD_REQUEST", details: [] }), false);
});

test("apiErrorMessage preserves error-like object message fallback", () => {
  class ProviderError {
    message = "provider said no";
  }

  assert.equal(
    apiErrorMessage({ error: "canonical", code: "BAD_REQUEST" }, "fallback"),
    "canonical",
  );
  assert.equal(apiErrorMessage(new Error("boom"), "fallback"), "boom");
  assert.equal(apiErrorMessage(new ProviderError(), "fallback"), "provider said no");
  assert.equal(apiErrorMessage({ message: "" }, "fallback"), "fallback");
});
