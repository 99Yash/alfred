/**
 * The MCP servers that a run's integration allowlist admits. `mcp` names the transport, so it is
 * never on an allowlist. A built-in server belongs to one integration (`BUILT_IN_MCP_CATALOG`),
 * derived from its pinned endpoint, never stored (ADR-0093).
 */

import { builtInMCPProvidersAdmittedBy, type IntegrationSlug } from "@alfred/contracts";

import { builtInProviderForEndpoint } from "./built-ins";
import { listOwnedServerEndpoints } from "./persistence";

/**
 * `null` when the allowlist is empty: the run has no integration limit, so every owned server is
 * admitted. Otherwise the ids of the owned built-in servers whose integration is on the list.
 */
export async function mcpServerIdsAdmittedBy(
  userId: string,
  allowedIntegrations: readonly IntegrationSlug[] | undefined,
): Promise<readonly string[] | null> {
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
