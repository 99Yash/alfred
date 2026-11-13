/**
 * The MCP servers that a run's integration allowlist admits. `mcp` names the transport, so it is
 * never on an allowlist. A built-in server belongs to one integration (`BUILT_IN_MCP_CATALOG`),
 * derived from its pinned endpoint, never stored (ADR-0093).
 */

import {
  BUILT_IN_MCP_CATALOG,
  builtInMCPProvidersAdmittedBy,
  type IntegrationSlug,
} from "@alfred/contracts";

import { builtInProviderForEndpoint } from "./built-ins";
import { listOwnedServerEndpoints, readOwnedConnection } from "./persistence";

/**
 * The MCP servers that a run can reach. `null`: the run has no integration limit. A list: only
 * these owned server ids. Discovery, the connected summary, and the broker take the same value.
 */
export type McpServerScope = readonly string[] | null;

/**
 * `null` when the allowlist is empty: the run has no integration limit, so every owned server is
 * admitted. Otherwise the ids of the owned built-in servers whose integration is on the list.
 */
export async function mcpServerIdsAdmittedBy(
  userId: string,
  allowedIntegrations: readonly IntegrationSlug[] | undefined,
): Promise<McpServerScope> {
  if (!allowedIntegrations || allowedIntegrations.length === 0) return null;

  const admitted = new Set(builtInMCPProvidersAdmittedBy(allowedIntegrations));

  if (admitted.size === 0) return [];

  const servers = await listOwnedServerEndpoints(userId);

  return servers
    .filter((server) => {
      const provider = builtInProviderForEndpoint(server.endpointUrl);

      return provider !== undefined && admitted.has(provider);
    })
    .map((server) => server.id);
}

/** True when `scope` admits the server. A `null` scope admits every owned server. */
export function mcpScopeAdmits(scope: McpServerScope, serverId: string): boolean {
  return scope === null || scope.includes(serverId);
}

/**
 * The integration whose policy rule governs a call on this connection: the integration of its
 * built-in server (the `github` rule for the GitHub MCP). `null` for a user-added server or an
 * unknown connection. Those keep the rule of the `mcp` tool.
 */
export async function integrationOfMcpConnection(
  userId: string,
  connectionId: string,
): Promise<IntegrationSlug | null> {
  const connection = await readOwnedConnection(connectionId, userId);

  if (!connection) return null;

  const provider = builtInProviderForEndpoint(connection.server.endpointUrl);

  return provider === undefined ? null : BUILT_IN_MCP_CATALOG[provider].slug;
}
