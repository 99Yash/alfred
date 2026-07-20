import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TransportErrorKind } from "@alfred/contracts";
import {
  passthroughBinaryResult,
  passthroughHttpResult,
  passthroughRejection,
  passthroughTransportError,
} from "../../../src/modules/tools/passthrough";

describe("passthroughHttpResult — succeeded semantics", () => {
  test("a 2xx with no GraphQL errors succeeds and preserves the body", () => {
    const r = passthroughHttpResult({ status: 200, body: { hello: "world" } });
    assert.equal(r.outcome, "http");
    if (r.outcome !== "http") return;
    assert.equal(r.status, 200);
    assert.equal(r.succeeded, true);
    assert.deepEqual(r.body, { hello: "world" });
  });

  test("a 4xx keeps the API error body but marks succeeded false (never a confident zero)", () => {
    const r = passthroughHttpResult({ status: 404, body: { message: "Not Found" } });
    if (r.outcome !== "http") return assert.fail("expected http");
    assert.equal(r.status, 404);
    assert.equal(r.succeeded, false);
    assert.deepEqual(r.body, { message: "Not Found" });
  });

  test("GraphQL partial success (HTTP 200 with errors[]) sets succeeded false yet keeps partial data", () => {
    const body = { data: { me: { id: 1 } }, errors: [{ message: "field x failed" }] };
    const r = passthroughHttpResult({ status: 200, body, graphqlHasErrors: true });
    if (r.outcome !== "http") return assert.fail("expected http");
    assert.equal(r.succeeded, false, "errors[] means not-complete");
    assert.deepEqual(r.body, body, "partial data still rides in body");
  });

  test("a clipped body attaches the truncation thermometer", () => {
    const r = passthroughHttpResult({ status: 200, body: { blob: "q".repeat(9000) } });
    if (r.outcome !== "http") return assert.fail("expected http");
    assert.ok(r.truncation, "expected truncation on a clipped body");
    assert.equal(r.truncation?.handleEligible, true);
  });
});

describe("passthroughBinaryResult", () => {
  test("binary bytes never enter the transcript — descriptor only, succeeded false", () => {
    const r = passthroughBinaryResult({
      status: 200,
      contentType: "application/pdf",
      byteCount: 43000,
    });
    if (r.outcome !== "http") return assert.fail("expected http");
    assert.equal(r.succeeded, false);
    assert.deepEqual(r.body, {
      binary: true,
      contentType: "application/pdf",
      byteCount: 43000,
      note: "Binary response omitted from the transcript. Use a curated download/export tool for the bytes.",
    });
  });
});

describe("passthroughRejection", () => {
  test("a gate denial becomes a visible rejected envelope carrying reason + message", () => {
    const r = passthroughRejection({
      ok: false,
      reason: "method_not_read",
      detail: "Method 'DELETE' is not a read method.",
    });
    assert.equal(r.outcome, "rejected");
    if (r.outcome !== "rejected") return;
    assert.equal(r.reason, "method_not_read");
    assert.equal(r.message, "Method 'DELETE' is not a read method.");
  });
});

describe("passthroughTransportError", () => {
  const cases: Array<[TransportErrorKind, boolean]> = [
    ["timeout", true],
    ["connection_reset", true],
    ["dns", false],
    ["tls", false],
  ];
  for (const [kind, retryable] of cases) {
    test(`${kind} → retryable=${retryable}`, () => {
      const r = passthroughTransportError(kind, "boom");
      assert.equal(r.outcome, "transport");
      if (r.outcome !== "transport") return;
      assert.equal(r.kind, kind);
      assert.equal(r.retryable, retryable);
    });
  }

  test("transport messages are secret-redacted", () => {
    const r = passthroughTransportError(
      "timeout",
      "failed with Authorization: Bearer sk-abc1234567890",
    );
    if (r.outcome !== "transport") return assert.fail("expected transport");
    assert.doesNotMatch(r.message, /sk-abc1234567890/);
    assert.match(r.message, /redacted/);
  });
});
