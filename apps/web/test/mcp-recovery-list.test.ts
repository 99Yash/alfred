import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import type { McpRecoveryOperation } from "@alfred/contracts";
import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { client } from "../src/lib/eden";
import { flattenMcpRecoveryPages } from "../src/routes/-integrations/helpers";
import { McpRecoveryList } from "../src/routes/-integrations/mcp-recovery-list";

type McpRecoveryRoute = ReturnType<typeof client.api.integrations.mcp.recovery>;
type McpResolveBody = Parameters<McpRecoveryRoute["resolve"]["post"]>[0];

const validResolveBody: McpResolveBody = { decision: "confirmed_succeeded" };
// @ts-expect-error the Eden request body must stay the canonical closed decision union.
const invalidResolveBody: McpResolveBody = { decision: "not_a_recovery_decision" };
void validResolveBody;
void invalidResolveBody;

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

const secondOperation: McpRecoveryOperation = {
  ...operation,
  invocationId: "mcpi_2",
  connection: { id: "mcpc_2", label: "Shipping MCP" },
  remoteName: "book_shipment",
};

const preparedSuccessor: McpRecoveryOperation = {
  ...operation,
  invocationId: "mcpi_successor",
  successorOf: operation.invocationId,
  attemptLifecycle: "prepared",
  effectOutcome: null,
  retryDisposition: null,
  deliveryPossibleAt: null,
  responseReceivedAt: null,
};

const baseProps = {
  awaitingRepair: 0,
  loading: false,
  readError: false,
  hasNextPage: false,
  loadingMore: false,
  mutationPending: false,
  mutationError: false,
  onReadRetry() {},
  onLoadMore() {},
  onResolve() {},
  onRetry() {},
};

test("MCP recovery disables every action across two operations during one mutation", () => {
  const html = renderToStaticMarkup(
    createElement(McpRecoveryList, {
      ...baseProps,
      operations: [operation, secondOperation],
      mutationPending: true,
    }),
  );

  assert.match(html, /Billing MCP/);
  assert.match(html, /Shipping MCP/);
  assert.match(html, /send_invoice/);
  assert.match(html, /book_shipment/);
  assert.match(html, /inv_42/);
  assert.equal((html.match(/It completed/g) ?? []).length, 2);
  assert.equal((html.match(/It did not apply/g) ?? []).length, 2);
  assert.equal((html.match(/Working…/g) ?? []).length, 2);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 6);
  assert.doesNotMatch(html, /proposedInput|decidedInput/);
});

test("MCP recovery gives a prepared successor only one explicit resume action", () => {
  const html = renderToStaticMarkup(
    createElement(McpRecoveryList, {
      ...baseProps,
      operations: [preparedSuccessor],
    }),
  );

  assert.match(html, /Authorized retry is ready to resume/);
  assert.match(html, /Resume exact operation/);
  assert.equal((html.match(/<button/g) ?? []).length, 1);
  assert.doesNotMatch(html, /It completed|It did not apply|might have completed/);
});

test("MCP recovery distinguishes loading, failed reads, and an empty result", () => {
  const loadingHtml = renderToStaticMarkup(
    createElement(McpRecoveryList, {
      ...baseProps,
      operations: [],
      loading: true,
    }),
  );
  const errorHtml = renderToStaticMarkup(
    createElement(McpRecoveryList, {
      ...baseProps,
      operations: [],
      readError: true,
    }),
  );
  const emptyHtml = renderToStaticMarkup(
    createElement(McpRecoveryList, {
      ...baseProps,
      operations: [],
    }),
  );

  assert.match(loadingHtml, /Loading MCP recovery operations/);
  assert.doesNotMatch(loadingHtml, /Could not load|No MCP operations/);
  assert.match(errorHtml, /Could not load MCP recovery operations/);
  assert.match(errorHtml, />Retry</);
  assert.doesNotMatch(errorHtml, /No MCP operations need recovery/);
  assert.match(emptyHtml, /No MCP operations need recovery/);
  assert.doesNotMatch(emptyHtml, /Could not load|>Retry</);
});

test("MCP recovery read error binds the retry action", () => {
  let retries = 0;
  const tree = McpRecoveryList({
    ...baseProps,
    operations: [],
    readError: true,
    onReadRetry() {
      retries += 1;
    },
  });

  assert.ok(isValidElement<{ children?: ReactNode }>(tree));
  const retry = Children.toArray(tree.props.children)[1];
  assert.ok(isValidElement<{ onClick?: () => void }>(retry));
  retry.props.onClick?.();
  assert.equal(retries, 1);
});

test("MCP recovery accumulates operations from every loaded page", () => {
  const operations = flattenMcpRecoveryPages([
    { operations: [operation], nextCursor: "cursor-2", awaitingRepair: 0 },
    { operations: [secondOperation, preparedSuccessor], nextCursor: null, awaitingRepair: 0 },
  ]);

  assert.deepEqual(
    operations.map((item) => item.invocationId),
    ["mcpi_1", "mcpi_2", "mcpi_successor"],
  );
});

test("MCP recovery binds the explicit load-more control", () => {
  let loads = 0;
  const tree = McpRecoveryList({
    ...baseProps,
    operations: [operation],
    hasNextPage: true,
    onLoadMore() {
      loads += 1;
    },
  });

  assert.ok(isValidElement<{ children?: ReactNode }>(tree));
  const loadMore = Children.toArray(tree.props.children).find(
    (child) =>
      isValidElement<{ children?: ReactNode }>(child) && child.props.children === "Load more",
  );
  assert.ok(isValidElement<{ onClick?: () => void }>(loadMore));
  loadMore.props.onClick?.();
  assert.equal(loads, 1);
});

test("MCP recovery reports rows that are still being recorded without a button", () => {
  const emptyHtml = renderToStaticMarkup(
    createElement(McpRecoveryList, {
      ...baseProps,
      operations: [],
      awaitingRepair: 3,
    }),
  );
  const listHtml = renderToStaticMarkup(
    createElement(McpRecoveryList, {
      ...baseProps,
      operations: [preparedSuccessor],
      awaitingRepair: 1,
    }),
  );

  assert.match(emptyHtml, /No MCP operations need recovery/);
  assert.match(emptyHtml, /3 operations are still being recorded/);
  assert.equal((emptyHtml.match(/<button/g) ?? []).length, 0);
  assert.match(listHtml, /1 operation is still being recorded/);
  assert.equal((listHtml.match(/<button/g) ?? []).length, 1);
});

test("MCP recovery confirms inline instead of through window.confirm", async () => {
  const source = await readFile(
    new URL("../src/routes/-integrations/mcp-recovery-list.tsx", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /window\.confirm/);
  const html = renderToStaticMarkup(
    createElement(McpRecoveryList, { ...baseProps, operations: [operation] }),
  );
  assert.doesNotMatch(html, />Confirm<|>Cancel</, "the confirm step is closed at first render");
});
