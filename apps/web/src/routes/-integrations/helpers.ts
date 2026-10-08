import type {
  BuiltInMCPProvider,
  McpRecoveryOperation,
  McpRecoveryOperationsPage,
} from "@alfred/contracts";
import { API_URL, type client, type EdenData } from "~/lib/eden";
import {
  CATEGORY_ORDER,
  matchesIntegration,
  type IntegrationCategory,
  type IntegrationPage,
} from "~/lib/integrations/integrations";

export type Section = {
  title: IntegrationCategory;
  providers: ReadonlyArray<IntegrationPage>;
};

export const MCP_SECTION = {
  heading: "Your Integrations",
  name: "MCP Server",
  description: "Connect any MCP server to extend Alfred.",
} as const;

export const BUILT_IN_MCP_HAYSTACK = `${MCP_SECTION.heading} ${MCP_SECTION.name} ${MCP_SECTION.description}`;

/** MCP connection list key. Each mutating component invalidates it itself; no refresh callback is passed down. */
export const MCP_CONNECTIONS_QUERY_KEY = ["integrations", "mcp", "connections"] as const;

type McpConnectionsResponse = EdenData<typeof client.api.integrations.mcp.connections.get>;

/** Derived from the route, so a new server field reaches every reader. */
export type McpConnection = McpConnectionsResponse["connections"][number];

/** One connection's catalog key. The panel owns this read; the list never passes a catalog in. */
export const MCP_CONNECTION_TOOLS_QUERY_KEY = [
  "integrations",
  "mcp",
  "connection",
  "tools",
] as const;

type McpConnectionRoute = ReturnType<typeof client.api.integrations.mcp.connections>;

export type McpConnectionToolPage = EdenData<McpConnectionRoute["tools"]["get"]>;

export type McpConnectionTool = McpConnectionToolPage["tools"][number];

export type McpConnectionToolInspection = EdenData<McpConnectionRoute["tools"]["inspect"]["get"]>;

/** A child of the tools key, so a catalog invalidation also clears reviews. */
export const MCP_TOOL_POLICY_QUERY_KEY = [...MCP_CONNECTION_TOOLS_QUERY_KEY, "policy"] as const;

export type McpToolPolicyState = EdenData<McpConnectionRoute["tools"]["policy"]["get"]>;

export type McpToolPolicy = Extract<McpToolPolicyState, { status: "reviewed" }>["policy"];

/** Shares the catalog review key family. */
export const MCP_HEALTH_MAPPING_QUERY_KEY = [
  ...MCP_CONNECTION_TOOLS_QUERY_KEY,
  "health-mapping",
] as const;

export type McpHealthMappingWireState = EdenData<
  McpConnectionRoute["tools"]["health-mapping"]["get"]
>;

/** Consent URL for a stored connection. A browser navigation, not a fetch. */
export function mcpAuthorizeUrl(connectionId: string): string {
  return `${API_URL}/api/integrations/mcp/connections/${connectionId}/authorize`;
}

export function mcpBuiltInConnectUrl(provider: BuiltInMCPProvider): string {
  return `${API_URL}/api/integrations/mcp/built-ins/${provider}/connect`;
}

export function matches(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase();

  if (!q) return true;

  return haystack.toLowerCase().includes(q);
}

export function filterSections(
  providers: ReadonlyArray<IntegrationPage>,
  query: string,
): ReadonlyArray<Section> {
  return CATEGORY_ORDER.flatMap((category) => {
    const matched = providers.filter(
      (provider) => provider.category === category && matchesIntegration(provider, query),
    );

    return matched.length > 0 ? [{ title: category, providers: matched }] : [];
  });
}

/** The "Connected" section above the catalog categories, from `useResolvedIntegrations()`. */
export function buildConnectedSection(
  resolved: ReadonlyArray<IntegrationPage>,
  query: string,
): Section | null {
  const connected = resolved.filter(
    (p) => p.status === "connected" && matchesIntegration(p, query),
  );

  if (connected.length === 0) return null;

  return { title: "Connected", providers: connected };
}

export function flattenMcpRecoveryPages(
  pages: ReadonlyArray<McpRecoveryOperationsPage> | undefined,
): ReadonlyArray<McpRecoveryOperation> {
  return pages?.flatMap((page) => page.operations) ?? [];
}
