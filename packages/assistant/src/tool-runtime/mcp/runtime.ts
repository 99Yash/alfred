/**
 * Process-wide MCP execution broker, built lazily once.
 * It wraps the connection manager's client cache, so all dispatches share one.
 * Kept apart from the manager singleton so imports go only `tool-runtime -> connections`.
 */

import { getMcpConnectionManager } from "@alfred/assistant/connections/mcp";
import { McpExecutionBroker } from "./broker";

let broker: McpExecutionBroker | undefined;

export function getMcpExecutionBroker(): McpExecutionBroker {
  return (broker ??= new McpExecutionBroker(getMcpConnectionManager()));
}

/** Test-only: replace or clear the singleton. */
export function _setMcpExecutionBrokerForTests(next?: McpExecutionBroker): void {
  broker = next;
}
