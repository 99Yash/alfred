import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ToolName } from "@alfred/contracts";
import { isRecord } from "@alfred/contracts";
import {
  executedResultOutcome,
  isNonExecutionFailure,
  toolCallLogStatus,
  toolResultMessage,
} from "../../../../src/tool-runtime/internal/result-routing";
import type { ToolCallDispatchResult } from "../../../../src/tool-runtime/internal/dispatch";
/**
 * A read-gate `rejected` and a `feature_disabled` route in opposite ways. The model must
 * see a gate rejection to self-correct. `feature_disabled` is hidden as `nonExecution`.
 * Tests the shared router in `result-routing.ts`.
 */

const REQUEST: ToolName = "vercel.request";

describe("read-gate `rejected` is a VISIBLE, model-facing result", () => {
  const gateRejected: Extract<ToolCallDispatchResult, { kind: "executed" }> = {
    kind: "executed",
    stagingId: null,
    toolResult: {
      outcome: "rejected",
      reason: "method_not_read",
      message: "This request uses a write method. The general tier is read-only.",
    },
    effects: {},
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
      integration: "vercel",
      message: "Vercel raw API access is turned off. Enable it under Settings → Features.",
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
      { kind: "executed", stagingId: "s1", toolResult: { ok: true }, effects: {}, editedByUser },
    );

    assert.ok(Array.isArray(message.content), "expected tool-result content");
    const content: unknown = message.content[0];
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

describe("executedResultOutcome gives one outcome to the log, the record, and the span", () => {
  const MCP_CALL: ToolName = "mcp.call";

  const executed = (
    toolResult: unknown,
  ): Extract<ToolCallDispatchResult, { kind: "executed" }> => ({
    kind: "executed",
    stagingId: "s1",
    toolResult,
    effects: {},
    editedByUser: false,
  });

  const toolError = { ok: false, status: "tool_error", result: { content: [] } };

  const blocked = {
    ok: false,
    status: "blocked",
    retry: "blocked",
    reason: "unresolved_effect",
    message: "An earlier attempt may have landed.",
  };

  const unknownEnvelope = { status: "unknown", retry: "blocked", message: "ambiguous delivery" };

  test("an mcp.call tool_error result is failed", () => {
    assert.equal(executedResultOutcome(MCP_CALL, toolError), "failed");
    assert.equal(toolCallLogStatus(MCP_CALL, executed(toolError)), "failed");
  });

  test("an mcp.call blocked result is failed", () => {
    assert.equal(executedResultOutcome(MCP_CALL, blocked), "failed");
    assert.equal(toolCallLogStatus(MCP_CALL, executed(blocked)), "failed");
  });

  test("an unknown-effect envelope is unknown, and the log shows it as failed", () => {
    assert.equal(executedResultOutcome(MCP_CALL, unknownEnvelope), "unknown");
    assert.equal(toolCallLogStatus(MCP_CALL, executed(unknownEnvelope)), "failed");
  });

  test("an mcp.call completed result is succeeded", () => {
    const completed = { status: "completed", result: { content: [] } };
    assert.equal(executedResultOutcome(MCP_CALL, completed), "succeeded");
    assert.equal(toolCallLogStatus(MCP_CALL, executed(completed)), "succeeded");
  });

  test("a system workflow draft that is blocked and ok stays succeeded", () => {
    const draft = { ok: true, status: "blocked" };
    assert.equal(executedResultOutcome("system.author_workflow", draft), "succeeded");
    assert.equal(toolCallLogStatus("system.author_workflow", executed(draft)), "succeeded");
  });
});
