import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { McpConnection } from "../src/routes/-integrations/helpers";
import { McpConnectionCardView } from "../src/routes/-integrations/mcp-connection-card";
import type { McpConnectionActions } from "../src/routes/-integrations/mcp-connection-actions";

const connection: McpConnection = {
  id: "mcpc_1",
  label: "Billing MCP",
  canonicalResource: "https://mcp.example.com/mcp",
  endpointOrigin: "https://mcp.example.com",
  builtInProvider: null,
  status: "ready",
  grantedScopes: [],
  requiredScopes: [],
  lastError: null,
  lastConnectedAt: new Date("2026-09-01T10:00:00.000Z"),
  updatedAt: new Date("2026-09-01T10:00:00.000Z"),
  toolCount: 3,
};

function actions(overrides: Partial<McpConnectionActions> = {}): McpConnectionActions {
  return {
    onReconnect() {},
    onDisconnect() {},
    onRename() {},
    onRemove() {},
    pending: null,
    error: null,
    ...overrides,
  };
}

function render(overrides: Partial<McpConnectionActions> = {}, status = connection.status) {
  return renderToStaticMarkup(
    createElement(McpConnectionCardView, {
      connection: { ...connection, status },
      actions: actions(overrides),
    }),
  );
}

test("the tile has one main button and keeps the rest behind the actions menu", async () => {
  const html = render();

  assert.match(html, /Billing MCP/);
  assert.match(html, /aria-label="Billing MCP actions"/);
  assert.doesNotMatch(html, />Disconnect<|>Remove<|>Rename</, "secondary actions are in the menu");

  const source = await readFile(
    new URL("../src/routes/-integrations/mcp-connection-card.tsx", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /window\.confirm/);
});

test("an auth_required connection offers consent and never a reconnect", () => {
  const html = render({}, "auth_required");

  assert.match(html, /Grant access/);
  assert.doesNotMatch(html, />Reconnect<|>Connect</);
});

test("a ready connection offers reconnect and shows its tool count", () => {
  const html = render();

  assert.match(html, />Reconnect</);
  assert.match(html, /Connected · 3 tools/);
});

test("a blocked removal renders the server message and the recovery anchor", () => {
  const html = render({
    error: {
      kind: "blocked_remove",
      action: "remove",
      message: "Resolve the pending MCP operation before removing this connection",
    },
  });

  assert.match(html, /Resolve the pending MCP operation before removing this connection/);
  assert.match(html, /href="#mcp-recovery"/);
});

test("a non-blocked action error renders without the recovery anchor", () => {
  const html = render({
    error: {
      kind: "action_failed",
      action: "reconnect",
      message: "Reconnect MCP server failed (400)",
    },
  });

  assert.match(html, /Reconnect MCP server failed \(400\)/);
  assert.doesNotMatch(html, /#mcp-recovery/);
});
