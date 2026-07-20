import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ToolName } from "@alfred/contracts";
import type { DispatchResult } from "../../../src/modules/dispatch";
import {
  isNonExecutionFailure,
  toolCallLogStatus,
} from "../../../src/modules/agent/workflows/chat-turn";

/**
 * The PRD's trickiest seam: a read-gate `rejected` and a `feature_disabled`
 * rejection route OPPOSITELY. A gate `rejected` is a normal tool execution whose
 * *value* is the rejection envelope — the boss must SEE it to self-correct, so it
 * rides `kind:"executed"` and is never `nonExecution`-hidden. A `feature_disabled`
 * rejection (the user turned the tier off) is invisible enforcement — hidden from
 * the chat UI via the `nonExecution` flag. These assert the classification the
 * chat-turn commit loop keys on, so the two can't drift into the same channel.
 */

const GRAPHQL: ToolName = "railway.graphql";

describe("read-gate `rejected` is a VISIBLE, model-facing result", () => {
  // The Railway adapter returns a `rejected` PassthroughResult, which the tool's
  // execute() returns — so it flows through dispatch as a normal executed result.
  const gateRejected: Extract<DispatchResult, { kind: "executed" }> = {
    kind: "executed",
    stagingId: null,
    toolResult: {
      outcome: "rejected",
      reason: "graphql_non_query",
      message: "This document contains a mutation operation. The general tier is read-only.",
    },
    editedByUser: false,
  };

  test("it is NOT a non-execution failure (so the chat UI shows it)", () => {
    assert.equal(isNonExecutionFailure(gateRejected), false);
  });

  test("its log status is succeeded — a read that honestly refused is not a failed side effect", () => {
    assert.equal(toolCallLogStatus(GRAPHQL, gateRejected), "succeeded");
  });
});

describe("`feature_disabled` is HIDDEN nonExecution plumbing", () => {
  const featureDisabled: Extract<DispatchResult, { kind: "feature_disabled" }> = {
    kind: "feature_disabled",
    result: {
      status: "feature_disabled",
      toolName: GRAPHQL,
      integration: "railway",
      message: "Railway raw API access is turned off. Enable it under Settings → Features.",
    },
  };

  test("it IS a non-execution failure (so the chat UI hides it)", () => {
    assert.equal(isNonExecutionFailure(featureDisabled), true);
  });

  test("its log status is failed — never executed", () => {
    assert.equal(toolCallLogStatus(GRAPHQL, featureDisabled), "failed");
  });

  test("the commit loop's hide condition (failed AND nonExecution) holds", () => {
    // Mirrors chat-turn: `nonExecution = status === "failed" && isNonExecutionFailure(result)`.
    const status = toolCallLogStatus(GRAPHQL, featureDisabled);
    const hidden = status === "failed" && isNonExecutionFailure(featureDisabled);
    assert.equal(hidden, true);
  });
});
