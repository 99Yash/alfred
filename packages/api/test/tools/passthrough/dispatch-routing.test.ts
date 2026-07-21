import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ToolName } from "@alfred/contracts";
import { isRecord } from "@alfred/contracts";
import {
  isNonExecutionFailure,
  toolCallLogStatus,
  toolResultMessage,
  type DispatchResult,
} from "../../../src/modules/dispatch";

/**
 * The PRD's trickiest seam: a read-gate `rejected` and a `feature_disabled`
 * rejection route OPPOSITELY. A gate `rejected` is a normal tool execution whose
 * *value* is the rejection envelope — the boss must SEE it to self-correct, so it
 * rides `kind:"executed"` and is never `nonExecution`-hidden. A `feature_disabled`
 * rejection (the user turned the tier off) is invisible enforcement — hidden from
 * the chat UI via the `nonExecution` flag. These test the shared result router
 * (`dispatch/result-routing`) the chat-turn commit loop consumes, so the two
 * can't drift into the same channel.
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
    // The commit loop keys on `status === "failed" && isNonExecutionFailure(result)`.
    const status = toolCallLogStatus(GRAPHQL, featureDisabled);
    const hidden = status === "failed" && isNonExecutionFailure(featureDisabled);
    assert.equal(hidden, true);
  });
});

describe("an executed result carries `editedByUser` to the model", () => {
  // The shared router surfaces the HIL edit flag on BOTH the chat turn and the
  // sub-agent brief; before the extraction chat silently dropped it, so this
  // pins the unified behavior against a re-drift.
  function executedValue(editedByUser: boolean): unknown {
    const message = toolResultMessage(
      { toolCallId: "call_1", toolName: GRAPHQL },
      { kind: "executed", stagingId: "s1", toolResult: { ok: true }, editedByUser },
    );
    const output = message.content[0]?.output;
    assert.ok(isRecord(output) && output.type === "json", "expected a json tool-result output");
    return output.value;
  }

  test("edited input surfaces editedByUser: true", () => {
    const value = executedValue(true);
    assert.ok(isRecord(value));
    assert.equal(value.status, "executed");
    assert.equal(value.editedByUser, true);
  });

  test("un-edited input still reports editedByUser: false (never omitted)", () => {
    const value = executedValue(false);
    assert.ok(isRecord(value));
    assert.equal(value.editedByUser, false);
  });
});
