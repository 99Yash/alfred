/**
 * Process-lifetime MCP connection-manager singleton (PRD #540). The manager
 * caches live `McpRawClient`s per connection for the process
 * lifetime, so it must be shared across every dispatch rather than constructed
 * per tool call; it is lazily built once here. Mirrors the lazy-singleton shape
 * of the action-policy resolver.
 *
 * The execution broker's singleton is deliberately NOT here — it lives in
 * `tool-runtime/mcp/runtime.ts`. Holding both in one file is what would force a
 * `connections` <-> `tool-runtime` module cycle, because the broker constructor
 * takes the manager. Split per module, the edge stays one-way: the broker
 * singleton reaches this one, and nothing in `connections` knows the broker
 * exists.
 *
 * The endpoint authorizer's singleton is NOT here either, and for the same
 * reason in miniature: this file imports `manager.ts`, so `manager.ts` cannot
 * import this file. `getMcpEndpointAuthorizer` therefore lives beside its class
 * in `endpoint-authorization.ts`, which every caller already reaches.
 *
 * Every connection — the GitHub built-in, an OAuth callback, and a user-added
 * server (#1004) — is reached through the full SSRF guard: the pinned DNS
 * lookup, the private-range refusal and the per-hop redirect revalidation that
 * `HostedMcpEndpointAuthorizer` owns.
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
