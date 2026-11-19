import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PassthroughResult } from "@alfred/contracts";
import { passthroughTruncationTelemetry } from "../../../../src/tool-runtime/internal/tools/passthrough";
import { passthroughSpanFacts } from "../../../../src/tool-runtime/internal/tools/passthrough/telemetry";

/**
 * Turns a cut passthrough result's `truncation` note into a span signal (ADR-0130 decision 5).
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
      limitBytes: 65_536,
      totalBytes: 100_000,
      cuts: [
        { path: "$", unit: "items", kept: 30, total: 150 },
        { path: "$[0].body", unit: "chars", kept: 500, total: 4_000 },
      ],
      note: "cut",
    },
  };
}

describe("passthroughSpanFacts + passthroughTruncationTelemetry", () => {
  test("emits the full L0-trigger signal for a truncated http success", () => {
    const t = telemetryFor("vercel.request", truncatedResult());
    assert.ok(t, "a truncated http result must produce a signal");
    assert.equal(t.integration, "vercel");
    assert.equal(t.toolName, "vercel.request");
    assert.equal(t.runId, RUN_ID);
    assert.equal(t.succeeded, true);
    assert.equal(t.limitBytes, 65_536);
    assert.equal(t.totalBytes, 100_000);
    assert.equal(t.droppedItems, 120);
    assert.equal(t.droppedChars, 3_500);
    assert.equal(t.cuts, 2);
  });

  test("carries succeeded:false through (a truncated error body is less interesting but still counted)", () => {
    const result: PassthroughResult = {
      outcome: "http",
      status: 500,
      succeeded: false,
      body: "x".repeat(100),
      truncation: {
        limitBytes: 65_536,
        totalBytes: 70_000,
        cuts: [{ path: "$", unit: "chars", kept: 60_000, total: 70_000 }],
        note: "cut",
      },
    };

    const t = telemetryFor("vercel.request", result);
    assert.ok(t);
    assert.equal(t.succeeded, false);
    assert.equal(t.integration, "vercel");
    assert.equal(t.droppedChars, 10_000);
  });

  test("returns null for a non-truncated http result", () => {
    const result: PassthroughResult = { outcome: "http", status: 200, succeeded: true, body: [] };
    assert.equal(telemetryFor("vercel.request", result), null);
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

    assert.equal(telemetryFor("vercel.request", rejected), null);
    assert.equal(telemetryFor("vercel.request", transport), null);
  });
});
