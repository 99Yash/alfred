/**
 * Process-lifetime MCP execution-broker singleton (PRD #540). The broker owns the
 * durable invocation ledger and sits on top of the connection manager's live
 * client cache, so it must be shared across every dispatch rather than
 * constructed per tool call; it is lazily built once here.
 *
 * The manager singleton it composes lives behind the `connections` door
 * (`@alfred/assistant/connections/mcp`). Keeping the two singletons in separate
 * modules is what keeps the module edge one-way — `tool-runtime -> connections`,
 * never back.
 */

import { getMcpConnectionManager } from "@alfred/assistant/connections/mcp";
import { McpExecutionBroker } from "./broker";

let broker: McpExecutionBroker | undefined;

export function getMcpExecutionBroker(): McpExecutionBroker {
  return (broker ??= new McpExecutionBroker(getMcpConnectionManager()));
}

/** Test-only: drop the singleton so a test can inject its own fake-backed broker. */
export function _setMcpExecutionBrokerForTests(next?: McpExecutionBroker): void {
  broker = next;
}
