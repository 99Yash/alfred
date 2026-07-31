import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mcpConnectionStatusText } from "../src/routes/-integrations/mcp-server-status";

describe("MCP connection status presentation", () => {
  test("renders every durable connection state", () => {
    assert.equal(mcpConnectionStatusText({ status: "ready", lastError: null }), "Connected");
    assert.equal(mcpConnectionStatusText({ status: "connecting", lastError: null }), "Connecting…");
    assert.equal(
      mcpConnectionStatusText({ status: "disconnected", lastError: null }),
      "Disconnected",
    );
    assert.equal(
      mcpConnectionStatusText({ status: "stale", lastError: null }),
      "Refreshing the tool catalog…",
    );
    assert.equal(
      mcpConnectionStatusText({ status: "auth_required", lastError: "Grant repo access" }),
      "Grant repo access",
    );
    assert.equal(
      mcpConnectionStatusText({ status: "failed", lastError: "Server unavailable" }),
      "Server unavailable",
    );
  });
});
