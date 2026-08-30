import assert from "node:assert/strict";
import { test } from "node:test";

import type { McpRecoveryOperation } from "@alfred/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { McpRecoveryList } from "../src/routes/-integrations/mcp-recovery-list";

const operation: McpRecoveryOperation = {
  invocationId: "mcpi_1",
  successorOf: null,
  connection: { id: "mcpc_1", label: "Billing MCP" },
  remoteName: "send_invoice",
  displayInput: { invoiceId: "inv_42" },
  attemptLifecycle: "delivery_possible",
  effectOutcome: "unknown",
  retryDisposition: "blocked",
  deliveryPossibleAt: new Date("2026-08-30T08:00:00.000Z"),
  responseReceivedAt: null,
  lastError: "Connection closed",
  traceId: "run_1",
  stepId: "dispatch-tools",
  toolCallId: "tc_1",
};

test("MCP recovery renders only explicit, disabled actions for an in-flight mutation", () => {
  const html = renderToStaticMarkup(
    createElement(McpRecoveryList, {
      operations: [operation],
      pendingInvocationId: operation.invocationId,
      error: false,
      onResolve() {},
      onRetry() {},
    }),
  );

  assert.match(html, /Billing MCP/);
  assert.match(html, /send_invoice/);
  assert.match(html, /inv_42/);
  assert.match(html, /It completed/);
  assert.match(html, /It did not apply/);
  assert.match(html, /Working…/);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 3);
  assert.doesNotMatch(html, /proposedInput|decidedInput/);
});

test("MCP recovery renders no mutation controls when there is no operation", () => {
  const html = renderToStaticMarkup(
    createElement(McpRecoveryList, {
      operations: [],
      pendingInvocationId: null,
      error: false,
      onResolve() {},
      onRetry() {},
    }),
  );
  assert.equal(html, "");
});
