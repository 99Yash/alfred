import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MCP_RECOVERY_PAGE_SIZE,
  mcpRecoveryDecisionBodySchema,
  mcpRecoveryDecisionSchema,
  mcpRecoveryOperationSchema,
  mcpRecoveryOperationsPageInputSchema,
  mcpRecoveryOperationsPageQuerySchema,
  mcpRecoveryOperationsPageSchema,
} from "../src/mcp";

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
  assert.equal(
    mcpRecoveryDecisionBodySchema.safeParse({ decision: "confirmed_not_applied" }).success,
    true,
  );
  assert.equal(mcpRecoveryDecisionBodySchema.safeParse({}).success, false);
  assert.equal(
    mcpRecoveryDecisionBodySchema.safeParse({ decision: "confirmed_succeeded", extra: true })
      .success,
    false,
  );
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

test("MCP recovery pages keep one fixed bound and an opaque nullable cursor", () => {
  assert.equal(mcpRecoveryOperationsPageQuerySchema.safeParse({}).success, true);
  assert.equal(
    mcpRecoveryOperationsPageQuerySchema.safeParse({ cursor: "cursor-2" }).success,
    true,
  );
  assert.equal(mcpRecoveryOperationsPageQuerySchema.safeParse({ cursor: "" }).success, false);
  assert.equal(
    mcpRecoveryOperationsPageInputSchema.safeParse({ userId: "user-1", cursor: "cursor-2" })
      .success,
    true,
  );
  assert.equal(
    mcpRecoveryOperationsPageInputSchema.safeParse({ cursor: "cursor-2" }).success,
    false,
  );
  assert.equal(
    mcpRecoveryOperationsPageSchema.safeParse({
      operations: Array.from({ length: MCP_RECOVERY_PAGE_SIZE }, (_, index) => ({
        ...operation,
        invocationId: `mcpi_${index}`,
      })),
      nextCursor: "cursor-2",
      awaitingRepair: 0,
    }).success,
    true,
  );
  assert.equal(
    mcpRecoveryOperationsPageSchema.safeParse({
      operations: Array.from({ length: MCP_RECOVERY_PAGE_SIZE + 1 }, (_, index) => ({
        ...operation,
        invocationId: `mcpi_${index}`,
      })),
      nextCursor: null,
      awaitingRepair: 0,
    }).success,
    false,
  );
  assert.equal(
    mcpRecoveryOperationsPageSchema.safeParse({ operations: [], nextCursor: "", awaitingRepair: 0 })
      .success,
    false,
  );
  assert.equal(
    mcpRecoveryOperationsPageSchema.safeParse({ operations: [], nextCursor: null }).success,
    false,
    "a page must state how many rows are still awaiting repair",
  );
  assert.equal(
    mcpRecoveryOperationsPageSchema.safeParse({
      operations: [],
      nextCursor: null,
      awaitingRepair: -1,
    }).success,
    false,
  );
});
