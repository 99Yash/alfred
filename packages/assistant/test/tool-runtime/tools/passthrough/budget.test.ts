import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ToolName } from "@alfred/contracts";
import {
  PASSTHROUGH_PER_RUN_CEILING,
  passthroughBudgetExhausted,
} from "../../../../src/tool-runtime/internal/tools/passthrough";
import {
  isNonExecutionFailure,
  toolCallLogStatus,
} from "../../../../src/tool-runtime/internal/result-routing";
import type { ToolCallDispatchResult } from "../../../../src/tool-runtime/dispatch";

/**
 * The per-run passthrough ceiling, pure half (ADR-0074). The `budget_exhausted` envelope
 * must stay a visible executed result: not hidden as `nonExecution`, and not logged `failed`.
 */

const REQUEST: ToolName = "github.request";

describe("passthroughBudgetExhausted envelope", () => {
  test("carries the honest, model-facing shape", () => {
    const envelope = passthroughBudgetExhausted(PASSTHROUGH_PER_RUN_CEILING);
    assert.equal(envelope.outcome, "budget_exhausted");
    assert.equal(envelope.callsThisRun, PASSTHROUGH_PER_RUN_CEILING);
    assert.equal(envelope.ceiling, PASSTHROUGH_PER_RUN_CEILING);
    // Tell the model what to do next, not only that it was cut off.
    assert.match(envelope.message, /stop paginating/i);
    assert.match(envelope.message, new RegExp(String(PASSTHROUGH_PER_RUN_CEILING)));
  });
});

describe("a budget-exhausted result is VISIBLE, model-facing, not a failure", () => {
  const exhausted: Extract<ToolCallDispatchResult, { kind: "executed" }> = {
    kind: "executed",
    stagingId: "as_test",
    toolResult: passthroughBudgetExhausted(PASSTHROUGH_PER_RUN_CEILING),
    editedByUser: false,
  };

  test("it is NOT a non-execution failure (so the chat UI shows it)", () => {
    assert.equal(isNonExecutionFailure(exhausted), false);
  });

  test("its log status is succeeded — an honest refusal to paginate is not a failed side effect", () => {
    assert.equal(toolCallLogStatus(REQUEST, exhausted), "succeeded");
  });
});
