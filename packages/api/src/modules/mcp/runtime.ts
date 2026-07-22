/**
 * Process-lifetime MCP runtime singletons (PRD #540). The connection manager
 * caches live `McpRawClient`s per connection for the process lifetime, and the
 * execution broker sits on top of it; both must be shared across every dispatch,
 * so they are lazily constructed once here rather than per tool call. Mirrors the
 * lazy-singleton shape of the action-policy resolver.
 *
 * The default manager builds real clients against each connection's pinned
 * endpoint with the placeholder https/origin authorization (the full SSRF guard
 * is a later slice). No connection-creation route wires an untrusted endpoint
 * yet, so in practice `getReadyClient` only ever finds the connections a future
 * OAuth slice persists — until then a call fails cleanly with
 * `McpConnectionNotFoundError`.
 */

import { McpExecutionBroker } from "./broker";
import { McpConnectionManager } from "./manager";

let manager: McpConnectionManager | undefined;
let broker: McpExecutionBroker | undefined;

export function getMcpConnectionManager(): McpConnectionManager {
  return (manager ??= new McpConnectionManager());
}

export function getMcpExecutionBroker(): McpExecutionBroker {
  return (broker ??= new McpExecutionBroker(getMcpConnectionManager()));
}

/** Test-only: drop the singletons so a test can inject its own fake-backed pair. */
export function _setMcpRuntimeForTests(next: {
  manager?: McpConnectionManager;
  broker?: McpExecutionBroker;
}): void {
  manager = next.manager;
  broker = next.broker;
}
