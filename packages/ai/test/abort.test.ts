import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isCallerAbort } from "../src/abort";

/**
 * One predicate, two consumers that must agree, and a boundary that is easy to
 * get subtly wrong:
 *
 *  - `withFallback` drops a caller abort (re-issuing a cancelled request on the
 *    fallback bills a second call for an answer nobody is waiting for) but
 *    treats a timeout as switch-worthy;
 *  - `metered()` records a caller abort as a cancelled row and a timeout as an
 *    error row.
 *
 * Both invert on the same distinction, and both failure modes are quiet — a
 * duplicate bill, a mislabelled ledger row. `AbortSignal.timeout()` produces a
 * `DOMException` too, differing only in `name`, so this is pinned by name.
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
