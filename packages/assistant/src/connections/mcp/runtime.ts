/**
 * The process-wide connection manager; it caches live clients, so share one.
 * The broker singleton lives in `tool-runtime/mcp/runtime.ts` to avoid a module cycle.
 * Every connection goes through the SSRF guard in `HostedMcpEndpointAuthorizer`.
 */

import { McpConnectionManager } from "./manager";

let manager: McpConnectionManager | undefined;

export function getMcpConnectionManager(): McpConnectionManager {
  return (manager ??= new McpConnectionManager());
}

/** Test-only: replace or clear the singleton. */
export function _setMcpConnectionManagerForTests(next?: McpConnectionManager): void {
  manager = next;
}
