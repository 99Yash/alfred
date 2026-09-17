import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  McpConnectionTool,
  McpConnectionToolInspection,
} from "../src/routes/-integrations/helpers";
import {
  McpCatalogView,
  type McpCatalogViewProps,
} from "../src/routes/-integrations/mcp-connection-catalog";

const tool: McpConnectionTool = {
  ref: {
    kind: "mcp",
    connectionId: "mcpc_1",
    remoteName: "create_issue",
    catalogRevision: "rev_1",
  },
  namespace: "mcps_1",
  connection: { id: "mcpc_1", instanceKey: "default", label: "Billing MCP" },
  title: "Create issue",
  description: "Create a GitHub issue.",
};

const inspectionTool: McpConnectionToolInspection = {
  status: "tool",
  ref: tool.ref,
  connection: tool.connection,
  tool: {
    name: "create_issue",
    title: "Create issue",
    description: "Create a GitHub issue.",
    // Untrusted nested field: must never be rendered as markup.
    inputSchema: { properties: { remoteSecret: "top-secret-value" } },
  },
};

function render(overrides: Partial<McpCatalogViewProps> = {}) {
  return renderToStaticMarkup(
    createElement(McpCatalogView, {
      connectionStatus: "ready",
      connectionLastError: null,
      loading: false,
      readError: false,
      tools: [],
      hasNextPage: false,
      loadingMore: false,
      onLoadMore() {},
      onRetry() {},
      selectedRemoteName: null,
      inspection: null,
      inspectionLoading: false,
      policyReview: null,
      onSelect() {},
      onDismissInspection() {},
      ...overrides,
    }),
  );
}

test("MCP catalog distinguishes loading, a failed read, and an empty catalog", () => {
  const loading = render({ loading: true });
  const readError = render({ readError: true });
  const empty = render();

  assert.match(loading, /Loading tools…/);
  assert.doesNotMatch(loading, /Could not load MCP tools|No tools are published/);
  assert.match(readError, /Could not load MCP tools/);
  assert.match(readError, />Retry</);
  assert.match(empty, /No tools are published for this connection yet/);
  assert.doesNotMatch(empty, /Could not load MCP tools/);
});

test("MCP catalog renders a populated page from the persisted slice", () => {
  const html = render({ tools: [tool] });

  assert.match(html, /Create issue/);
  assert.match(html, /create_issue/);
  assert.match(html, /Create a GitHub issue\./);
  assert.match(html, />Inspect</);
});

test("MCP catalog keeps the connection's persisted status above the list", () => {
  const html = render({ connectionStatus: "failed", connectionLastError: "Server unavailable" });

  assert.match(html, /Server unavailable/);
  assert.match(html, /No tools are published for this connection yet/);
});

test("MCP catalog renders a stale or missing descriptor as a refusal, not an empty list", () => {
  const notFound: McpConnectionToolInspection = {
    status: "not_found",
    ref: tool.ref,
    message: "This MCP tool is not available for the current user.",
  };

  const catalogStale: McpConnectionToolInspection = {
    status: "catalog_stale",
    ref: tool.ref,
    message: "The MCP catalog changed. Search again and select a current tool reference.",
  };

  const notFoundHtml = render({ tools: [tool], inspection: notFound });
  const staleHtml = render({ tools: [tool], inspection: catalogStale });

  assert.match(notFoundHtml, /not available for the current user/);
  assert.match(notFoundHtml, /Back to tools/);
  assert.match(staleHtml, /The MCP catalog changed/);
  assert.match(staleHtml, />Back to tools</);
});

test("MCP catalog renders an inspected descriptor through getStringPath, never raw", () => {
  const html = render({
    tools: [tool],
    selectedRemoteName: "create_issue",
    inspection: inspectionTool,
  });

  assert.match(html, /Create a GitHub issue\./);
  assert.doesNotMatch(html, /top-secret-value/);
  assert.doesNotMatch(html, /inputSchema/);
});

test("MCP catalog shows the inspection loading state before the descriptor arrives", () => {
  const html = render({
    tools: [tool],
    selectedRemoteName: "create_issue",
    inspectionLoading: true,
  });

  assert.match(html, /Loading tool…/);
  // The list stays visible while the exact descriptor loads; only the detail
  // panel is replaced by the loading line.
  assert.match(html, /create_issue/);
  assert.doesNotMatch(html, />Close<|>Back to tools</);
});
