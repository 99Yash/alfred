import assert from "node:assert/strict";
import { test } from "node:test";

import { mcpRecoveryDecisionSchema, mcpRecoveryOperationSchema } from "../src/mcp";

const operation = {
  invocationId: "mcpi_1",
  successorOf: null,
  connection: { id: "mcpc_1", label: "Billing MCP" },
  remoteName: "send_invoice",
  displayInput: { invoiceId: "inv_42" },
  attemptLifecycle: "delivery_possible",
  effectOutcome: "unknown",
  retryDisposition: "blocked",
  deliveryPossibleAt: "2026-08-30T08:00:00.000Z",
  responseReceivedAt: null,
  lastError: null,
  traceId: "run_1",
  stepId: "dispatch-tools",
  toolCallId: "tc_1",
};

test("MCP recovery accepts only closed host decisions", () => {
  assert.equal(mcpRecoveryDecisionSchema.safeParse("confirmed_succeeded").success, true);
  assert.equal(mcpRecoveryDecisionSchema.safeParse("confirmed_not_applied").success, true);
  assert.equal(mcpRecoveryDecisionSchema.safeParse("retry_automatically").success, false);
});

test("MCP recovery projection rejects raw staging fields", () => {
  assert.equal(mcpRecoveryOperationSchema.safeParse(operation).success, true);
  assert.equal(
    mcpRecoveryOperationSchema.safeParse({ ...operation, proposedInput: { secret: true } }).success,
    false,
  );
  assert.equal(
    mcpRecoveryOperationSchema.safeParse({ ...operation, decidedInput: { secret: true } }).success,
    false,
  );
});

test("MCP recovery exposes a prepared successor without inventing delivery evidence", () => {
  const prepared = {
    ...operation,
    invocationId: "mcpi_successor",
    successorOf: "mcpi_1",
    attemptLifecycle: "prepared",
    effectOutcome: null,
    retryDisposition: null,
    deliveryPossibleAt: null,
    responseReceivedAt: null,
  };

  assert.equal(mcpRecoveryOperationSchema.safeParse(prepared).success, true);
  assert.equal(
    mcpRecoveryOperationSchema.safeParse({
      ...prepared,
      deliveryPossibleAt: "2026-08-30T08:00:00.000Z",
    }).success,
    false,
  );
});
