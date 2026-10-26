import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PassthroughResult } from "@alfred/contracts";
import {
  passthroughSpanFacts,
  passthroughTruncationTelemetry,
} from "../../../../src/tool-runtime/internal/tools/passthrough";

/**
 * Turns a clipped passthrough result's `handleEligible` marker into a span signal (ADR-0074).
 * Fires only on a truncated `http` outcome. The tool's typed output feeds `passthroughSpanFacts`,
 * so the telemetry reads no `unknown`.
 */

const RUN_ID = "run_thermo_1";

function telemetryFor(toolName: string, result: PassthroughResult) {
  const facts = passthroughSpanFacts(result).passthroughTruncation;

  return facts === undefined ? null : passthroughTruncationTelemetry(toolName, RUN_ID, facts);
}

function truncatedResult(): PassthroughResult {
  return {
    outcome: "http",
    status: 200,
    succeeded: true,
    body: [{ id: 1 }],
    truncation: {
      handleEligible: true,
      originalBytesApprox: 10_000,
      returnedBytes: 4_000,
      causes: [
        { kind: "array_items", droppedApprox: 120 },
        { kind: "string_chars", droppedApprox: 3_500 },
      ],
    },
  };
}

describe("passthroughSpanFacts + passthroughTruncationTelemetry", () => {
  test("emits the full L0-trigger signal for a truncated http success", () => {
    const t = telemetryFor("github.request", truncatedResult());
    assert.ok(t, "a truncated http result must produce a signal");
    assert.equal(t.handleEligible, true);
    assert.equal(t.integration, "github");
    assert.equal(t.toolName, "github.request");
    assert.equal(t.runId, RUN_ID);
    assert.equal(t.succeeded, true);
    assert.equal(t.returnedBytes, 4_000);
    assert.equal(t.originalBytesApprox, 10_000);
    assert.equal(t.droppedBytesApprox, 6_000);
    assert.equal(t.droppedArrayItemsApprox, 120);
    assert.equal(t.droppedStringCharsApprox, 3_500);
    assert.equal(t.droppedBodyBytesApprox, 0);
    assert.equal(t.causes.length, 2);
  });

  test("carries succeeded:false through (a truncated error body is less interesting but still counted)", () => {
    const result: PassthroughResult = {
      outcome: "http",
      status: 500,
      succeeded: false,
      body: "x".repeat(100),
      truncation: {
        handleEligible: true,
        originalBytesApprox: 2_000,
        returnedBytes: 500,
        causes: [{ kind: "body_bytes", droppedApprox: 1_500 }],
      },
    };

    const t = telemetryFor("vercel.request", result);
    assert.ok(t);
    assert.equal(t.succeeded, false);
    assert.equal(t.integration, "vercel");
    assert.equal(t.droppedBodyBytesApprox, 1_500);
  });

  test("returns null for a non-truncated http result", () => {
    const result: PassthroughResult = { outcome: "http", status: 200, succeeded: true, body: [] };
    assert.equal(telemetryFor("github.request", result), null);
  });

  test("returns null for rejected / transport outcomes", () => {
    const rejected: PassthroughResult = {
      outcome: "rejected",
      reason: "method_not_read",
      message: "no",
    };

    const transport: PassthroughResult = {
      outcome: "transport",
      kind: "timeout",
      retryable: true,
      message: "timed out",
    };

    assert.equal(telemetryFor("github.request", rejected), null);
    assert.equal(telemetryFor("github.request", transport), null);
  });
});
