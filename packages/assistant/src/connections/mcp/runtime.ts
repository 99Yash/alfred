/**
 * Process-lifetime MCP connection-manager singleton (PRD #540). The manager
 * caches live `McpRawClient`s per connection for the process lifetime, so it must
 * be shared across every dispatch rather than constructed per tool call; it is
 * lazily built once here. Mirrors the lazy-singleton shape of the action-policy
 * resolver.
 *
 * The execution broker's singleton is deliberately NOT here — it lives in
 * `tool-runtime/mcp/runtime.ts`. Holding both in one file is what would force a
 * `connections` <-> `tool-runtime` module cycle, because the broker constructor
 * takes the manager. Split per module, the edge stays one-way: the broker
 * singleton reaches this one, and nothing in `connections` knows the broker
 * exists.
 *
 * The default manager builds real clients against each connection's pinned
 * endpoint with the placeholder https/origin authorization (the full SSRF guard
 * is a later slice). No connection-creation route wires an untrusted endpoint
 * yet, so in practice `getReadyClient` only ever finds the connections a future
 * OAuth slice persists — until then a call fails cleanly with
 * `McpConnectionNotFoundError`.
 */

import { McpConnectionManager } from "./manager";

let manager: McpConnectionManager | undefined;

export function getMcpConnectionManager(): McpConnectionManager {
  return (manager ??= new McpConnectionManager());
}

/** Test-only: drop the singleton so a test can inject its own fake-backed manager. */
export function _setMcpConnectionManagerForTests(next?: McpConnectionManager): void {
  manager = next;
}
