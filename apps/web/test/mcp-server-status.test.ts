import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mcpConnectionPresentation } from "../src/routes/-integrations/mcp-server-status";

describe("MCP connection status presentation", () => {
  test("renders every durable connection state", () => {
    assert.equal(
      mcpConnectionPresentation({ status: "ready", lastError: null }).statusText,
      "Connected",
    );
    assert.equal(
      mcpConnectionPresentation({ status: "connecting", lastError: null }).statusText,
      "Connecting…",
    );
    assert.equal(
      mcpConnectionPresentation({ status: "disconnected", lastError: null }).statusText,
      "Disconnected",
    );
    assert.equal(
      mcpConnectionPresentation({ status: "stale", lastError: null }).statusText,
      "Refreshing the tool catalog…",
    );
    assert.equal(
      mcpConnectionPresentation({ status: "auth_required", lastError: "Grant repo access" })
        .statusText,
      "Grant repo access",
    );
    assert.equal(
      mcpConnectionPresentation({ status: "failed", lastError: "Server unavailable" }).statusText,
      "Server unavailable",
    );
  });
});
