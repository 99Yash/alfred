import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ToolName, ToolUnavailabilityCode } from "@alfred/contracts";
import { toolEventOutcome } from "../../src/execution/workflows/tool-event-outcome";
import {
  completedToolCall,
  type TerminalToolCallDispatchResult,
} from "../../src/tool-runtime/internal/result-routing";

/** Only a connection-health refusal becomes a connect nudge, never a policy refusal. */

const SHEETS_APPEND: ToolName = "sheets.append_values";

const call = { toolCallId: "call_1", toolName: SHEETS_APPEND, input: {} };

const floorRefusal = (code: ToolUnavailabilityCode): TerminalToolCallDispatchResult => ({
  kind: "not_allowed",
  result: {
    status: "not_allowed",
    toolName: SHEETS_APPEND,
    integration: "sheets",
    message: `${code}: Sheets is not usable right now.`,
  },
  unavailability: code,
});

const completedOf = (result: TerminalToolCallDispatchResult) => completedToolCall(call, result);

describe("completedToolCall → connectNudge", () => {
  test("a not_connected refusal offers Connect", () => {
    assert.deepEqual(completedOf(floorRefusal("not_connected")).connectNudge, {
      integration: "sheets",
      action: "connect",
    });
  });

  test("needs_reauth and missing_scope offer Reconnect", () => {
    for (const code of ["needs_reauth", "missing_scope"] as const) {
      assert.deepEqual(completedOf(floorRefusal(code)).connectNudge, {
        integration: "sheets",
        action: "reconnect",
      });
    }
  });

  test("non-connection floor codes stay invisible plumbing", () => {
    for (const code of ["not_allowed", "wrong_caller", "requires_thread"] as const) {
      const completed = completedOf(floorRefusal(code));
      assert.equal(completed.connectNudge, undefined, code);
      assert.equal(completed.nonExecution, true);
    }
  });

  test("a workflow-capability mismatch is policy, not a repair", () => {
    const result: TerminalToolCallDispatchResult = {
      kind: "not_allowed",
      result: {
        status: "capability_mismatch",
        toolName: SHEETS_APPEND,
        integration: "sheets",
        message: "Outside the approved capability envelope.",
      },
    };

    const completed = completedToolCall(call, result);
    assert.equal(completed.connectNudge, undefined);
    assert.equal(completed.nonExecution, true);
  });

  test("feature_disabled keeps its hidden arm", () => {
    const result: TerminalToolCallDispatchResult = {
      kind: "feature_disabled",
      result: {
        status: "feature_disabled",
        toolName: SHEETS_APPEND,
        integration: "sheets",
        message: "Tier disabled.",
      },
    };

    assert.equal(completedToolCall(call, result).connectNudge, undefined);
  });
});

describe("toolEventOutcome → chat.tool payload fact", () => {
  test("the nudge rides the outcome beside nonExecution", () => {
    const outcome = toolEventOutcome(completedOf(floorRefusal("not_connected")));
    assert.equal(outcome.nonExecution, true);
    assert.deepEqual(outcome.connectNudge, { integration: "sheets", action: "connect" });
  });

  test("an executed call never carries one", () => {
    const outcome = toolEventOutcome(
      completedOf({
        kind: "executed",
        stagingId: null,
        toolResult: { ok: true },
        effects: {},
        editedByUser: false,
      }),
    );

    assert.equal(outcome.nonExecution, undefined);
    assert.equal(outcome.connectNudge, undefined);
  });
});
