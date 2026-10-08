import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ToolName } from "@alfred/contracts";
import { isRecord } from "@alfred/contracts";
import {
  isNonExecutionFailure,
  toolCallLogStatus,
  toolResultMessage,
} from "../../../../src/tool-runtime/internal/result-routing";
import type { ToolCallDispatchResult } from "../../../../src/tool-runtime/dispatch";

/**
 * A read-gate `rejected` and a `feature_disabled` route in opposite ways. The model must
 * see a gate rejection to self-correct. `feature_disabled` is hidden as `nonExecution`.
 * Tests the shared router in `result-routing.ts`.
 */

const REQUEST: ToolName = "notion.request";

describe("read-gate `rejected` is a VISIBLE, model-facing result", () => {
  const gateRejected: Extract<ToolCallDispatchResult, { kind: "executed" }> = {
    kind: "executed",
    stagingId: null,
    toolResult: {
      outcome: "rejected",
      reason: "method_not_read",
      message: "This request uses a write method. The general tier is read-only.",
    },
    editedByUser: false,
  };

  test("it is NOT a non-execution failure (so the chat UI shows it)", () => {
    assert.equal(isNonExecutionFailure(gateRejected), false);
  });

  test("its log status is succeeded — a read that honestly refused is not a failed side effect", () => {
    assert.equal(toolCallLogStatus(REQUEST, gateRejected), "succeeded");
  });
});

describe("`feature_disabled` is HIDDEN nonExecution plumbing", () => {
  const featureDisabled: Extract<ToolCallDispatchResult, { kind: "feature_disabled" }> = {
    kind: "feature_disabled",
    result: {
      status: "feature_disabled",
      toolName: REQUEST,
      integration: "notion",
      message: "Notion raw API access is turned off. Enable it under Settings → Features.",
    },
  };

  test("it IS a non-execution failure (so the chat UI hides it)", () => {
    assert.equal(isNonExecutionFailure(featureDisabled), true);
  });

  test("its log status is failed — never executed", () => {
    assert.equal(toolCallLogStatus(REQUEST, featureDisabled), "failed");
  });

  test("the commit loop's hide condition (failed AND nonExecution) holds", () => {
    const status = toolCallLogStatus(REQUEST, featureDisabled);
    const hidden = status === "failed" && isNonExecutionFailure(featureDisabled);
    assert.equal(hidden, true);
  });
});

describe("an executed result carries `editedByUser` to the model", () => {
  // Both the chat turn and the sub-agent brief must carry the edit flag.
  function executedValue(editedByUser: boolean): unknown {
    const message = toolResultMessage(
      { toolCallId: "call_1", toolName: REQUEST, input: {} },
      { kind: "executed", stagingId: "s1", toolResult: { ok: true }, editedByUser },
    );

    assert.ok(Array.isArray(message.content), "expected tool-result content");
    const content = message.content[0];
    assert.ok(isRecord(content), "expected a tool-result part");
    const output = content.output;
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
