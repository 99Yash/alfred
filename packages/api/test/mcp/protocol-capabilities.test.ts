import assert from "node:assert/strict";
import { test } from "node:test";
import { MCP_CLIENT_CAPABILITIES, MCP_INPUT_REQUIRED_PROFILE } from "../../src/modules/mcp";

test("Alfred does not advertise MRTR handlers", () => {
  assert.deepEqual(MCP_CLIENT_CAPABILITIES, {});
  assert.equal("roots" in MCP_CLIENT_CAPABILITIES, false);
  assert.equal("sampling" in MCP_CLIENT_CAPABILITIES, false);
  assert.equal("elicitation" in MCP_CLIENT_CAPABILITIES, false);
  assert.equal(MCP_INPUT_REQUIRED_PROFILE.autoFulfill, false);
});

test("Alfred does not advertise MCP Tasks", () => {
  assert.equal("tasks" in MCP_CLIENT_CAPABILITIES, false);
  assert.equal("extensions" in MCP_CLIENT_CAPABILITIES, false);
});
