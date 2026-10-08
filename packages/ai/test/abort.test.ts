import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isCallerAbort } from "../src/abort";

/**
 * `withFallback` and `metered()` both treat an abort and a timeout differently, and both fail quietly.
 * `AbortSignal.timeout()` also throws a `DOMException`, so only `name` tells them apart.
 */
describe("isCallerAbort", () => {
  test("matches a controller-initiated cancel", () => {
    const controller = new AbortController();
    controller.abort();
    assert.equal(controller.signal.reason.name, "AbortError", "Node's abort reason shape");
    assert.equal(isCallerAbort(controller.signal.reason), true);
    assert.equal(isCallerAbort(new DOMException("cancelled", "AbortError")), true);
  });

  test("does NOT match a timeout, which is the provider failing rather than us cancelling", () => {
    assert.equal(isCallerAbort(new DOMException("timed out", "TimeoutError")), false);
    assert.equal(isCallerAbort(AbortSignal.timeout(0).reason ?? new Error("x")), false);
  });

  test("does not match ordinary errors or non-errors", () => {
    assert.equal(isCallerAbort(new Error("boom")), false);
    assert.equal(
      isCallerAbort({ name: "AbortError" }),
      false,
      "a lookalike object is not an Error",
    );
    assert.equal(isCallerAbort(null), false);
    assert.equal(isCallerAbort("AbortError"), false);
  });
});
