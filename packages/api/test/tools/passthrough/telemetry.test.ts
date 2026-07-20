import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PassthroughResult } from "@alfred/contracts";
import { passthroughTruncationTelemetry } from "../../../src/modules/tools/passthrough";

/**
 * ADR-0074 thermometer (PRD User Story 17). The builder turns a clipped
 * passthrough result's `handleEligible` truncation marker into the structured
 * signal folded onto the tool span — the evidence gate for the object-handle
 * layer (L0). It must fire ONLY on a truncated `http` outcome, carry the exact
 * L0-trigger fields, and never throw on a malformed or non-passthrough result
 * (it runs on every tool's result, seen as `unknown`).
 */

const RUN_ID = "run_thermo_1";

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

describe("passthroughTruncationTelemetry", () => {
  test("emits the full L0-trigger signal for a truncated http success", () => {
    const t = passthroughTruncationTelemetry("github.request", RUN_ID, truncatedResult());
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
    const t = passthroughTruncationTelemetry("railway.graphql", RUN_ID, result);
    assert.ok(t);
    assert.equal(t.succeeded, false);
    assert.equal(t.integration, "railway");
    assert.equal(t.droppedBodyBytesApprox, 1_500);
  });

  test("returns null for a non-truncated http result", () => {
    const result: PassthroughResult = { outcome: "http", status: 200, succeeded: true, body: [] };
    assert.equal(passthroughTruncationTelemetry("github.request", RUN_ID, result), null);
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
    assert.equal(passthroughTruncationTelemetry("github.request", RUN_ID, rejected), null);
    assert.equal(passthroughTruncationTelemetry("github.request", RUN_ID, transport), null);
  });

  test("returns null (never throws) for a non-passthrough tool result", () => {
    assert.equal(passthroughTruncationTelemetry("github.search", RUN_ID, { items: [] }), null);
    assert.equal(passthroughTruncationTelemetry("system.load_tool", RUN_ID, "done"), null);
    assert.equal(passthroughTruncationTelemetry("github.request", RUN_ID, null), null);
  });

  test("drops malformed truncation causes without throwing", () => {
    const result = {
      outcome: "http",
      status: 200,
      succeeded: true,
      body: [],
      truncation: {
        handleEligible: true,
        originalBytesApprox: 100,
        returnedBytes: 10,
        causes: [
          { kind: "array_items", droppedApprox: 5 },
          { kind: "bogus_kind", droppedApprox: 9 },
          { kind: "string_chars" }, // missing droppedApprox
          "not an object",
        ],
      },
    };
    const t = passthroughTruncationTelemetry("notion.request", RUN_ID, result);
    assert.ok(t);
    assert.equal(t.causes.length, 1, "only the well-formed cause survives");
    assert.equal(t.droppedArrayItemsApprox, 5);
  });
});
