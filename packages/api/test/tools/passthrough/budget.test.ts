import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ToolName } from "@alfred/contracts";
import {
  PASSTHROUGH_PER_RUN_CEILING,
  passthroughBudgetExhausted,
} from "../../../src/modules/tools/passthrough";
import {
  isNonExecutionFailure,
  toolCallLogStatus,
  type DispatchResult,
} from "../../../src/modules/dispatch";

/**
 * ADR-0074 per-run passthrough ceiling (pure half). A runaway pagination loop
 * reads as forward progress and slips past the ADR-0070 non-progress backstop,
 * so the dispatcher caps cumulative raw passthrough calls per run. The cap does
 * NOT silently drop the call — it commits a VISIBLE `budget_exhausted` envelope
 * as a normal executed result so the boss reads it and stops paginating.
 *
 * These assert the two things the chat-turn commit loop keys on, so the
 * budget-exhausted notice can never drift into the hidden `nonExecution`
 * channel (which would cut the model off with no explanation) or a `failed`
 * side-effect log line (it never ran a side effect — it honestly refused).
 */

const REQUEST: ToolName = "github.request";

describe("passthroughBudgetExhausted envelope", () => {
  test("carries the honest, model-facing shape", () => {
    const envelope = passthroughBudgetExhausted(PASSTHROUGH_PER_RUN_CEILING);
    assert.equal(envelope.outcome, "budget_exhausted");
    assert.equal(envelope.callsThisRun, PASSTHROUGH_PER_RUN_CEILING);
    assert.equal(envelope.ceiling, PASSTHROUGH_PER_RUN_CEILING);
    // The message must tell the model what to do instead (stop / report / narrow),
    // not just that it was cut off — same result-honesty discipline as the gate.
    assert.match(envelope.message, /stop paginating/i);
    assert.match(envelope.message, new RegExp(String(PASSTHROUGH_PER_RUN_CEILING)));
  });
});

describe("a budget-exhausted result is VISIBLE, model-facing, not a failure", () => {
  // The dispatcher commits the ceiling hit as a normal executed result whose
  // VALUE is the envelope (mirrors the read-gate `rejected` routing).
  const exhausted: Extract<DispatchResult, { kind: "executed" }> = {
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
