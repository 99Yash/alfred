import assert from "node:assert/strict";
import test from "node:test";
import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  ApiError,
  apiErrorMessage,
  apiErrorResponse,
  Errors,
  isApiError,
  isApiErrorResponse,
  type ApiErrorCode,
} from "@alfred/contracts";

test("every code has a status, and every factory carries the code it names", () => {
  for (const code of API_ERROR_CODES) {
    const status = API_ERROR_STATUS[code];
    assert.equal(typeof status, "number", `${code} has no status`);
    assert.ok(status >= 400 && status <= 599, `${code} maps to a non-failure status`);
  }

  // Each factory owns exactly one code, and the error derives its own status —
  // a call site can never pair a status with a code that disagrees.
  const built = Object.values(Errors).map((make) => make());
  const codes = built.map((err) => err.code);
  assert.deepEqual([...codes].sort(), [...API_ERROR_CODES].sort());
  for (const err of built) {
    assert.equal(err.statusCode, API_ERROR_STATUS[err.code]);
    assert.ok(err.message.length > 0, `${err.code} has an empty default message`);
  }
});

test("isApiError narrows by code, and answers false for foreign errors", () => {
  const conflict = Errors.ConflictError("already ran");

  assert.equal(isApiError(conflict), true);
  assert.equal(isApiError(conflict, "CONFLICT"), true);
  assert.equal(isApiError(conflict, "BAD_REQUEST", "CONFLICT"), true);
  assert.equal(isApiError(conflict, "BAD_REQUEST"), false);
  assert.equal(isApiError(new Error("conflict"), "CONFLICT"), false);
  assert.equal(isApiError({ code: "CONFLICT" }, "CONFLICT"), false);
});

test("a factory error keeps the details it was given, on the error and on the wire", () => {
  const err = Errors.TooManyRequestsError("Slow down.", { retryAfterSeconds: 60 });

  assert.ok(err instanceof ApiError);
  assert.ok(err instanceof Error);
  assert.equal(err.statusCode, 429);
  assert.deepEqual(err.details, { retryAfterSeconds: 60 });
  assert.deepEqual(apiErrorResponse(err), {
    error: "Slow down.",
    code: "TOO_MANY_REQUESTS",
    details: { retryAfterSeconds: 60 },
  });

  // No details means no `details` key at all, not `details: undefined`.
  const bare = apiErrorResponse(Errors.NotFoundError());
  assert.equal("details" in bare, false);
  assert.equal(isApiErrorResponse(bare), true);
});

test("a factory name reads as the code it produces", () => {
  const codeFromFactoryName = (name: string): ApiErrorCode | undefined => {
    const stem = name.endsWith("Error") ? name.slice(0, -"Error".length) : name;
    const screaming = stem.replace(/(?<=[a-z0-9])(?=[A-Z])/g, "_").toUpperCase();
    const candidates: readonly string[] = [screaming, `${screaming}_ERROR`];
    return API_ERROR_CODES.find((code) => candidates.includes(code));
  };

  for (const [name, make] of Object.entries(Errors)) {
    assert.equal(make().code, codeFromFactoryName(name), `Errors.${name} names another code`);
  }
});

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
