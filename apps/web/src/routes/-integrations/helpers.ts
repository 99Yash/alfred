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

/**
 * The one cache key for the MCP connection list.
 *
 * Every component that reads or mutates a connection imports this key and
 * invalidates the list itself. The list owner does not hand a refresh callback
 * down, because a caller that forgets to pass it leaves a card that mutates and
 * never redraws.
 */
export const MCP_CONNECTIONS_QUERY_KEY = ["integrations", "mcp", "connections"] as const;

type McpConnectionsResponse = EdenData<typeof client.api.integrations.mcp.connections.get>;

/**
 * One row of the MCP connection list, as the wire hands it over.
 *
 * It lives here rather than on a card, because three components read it and a
 * component that owns a shared type makes a sibling import from a sibling
 * VIEW. The shape is derived from the route, never restated, so a field added
 * server-side reaches every reader at once.
 */
export type McpConnection = McpConnectionsResponse["connections"][number];

/**
 * The one cache key for one connection's catalog read.
 *
 * The per-connection route nests under the connection path, so the key carries
 * the connection id. The panel owns its own reads; the connection list does not
 * pass a catalog in, because a second reader would have to invalidate this key
 * separately and a caller that forgets leaves a stale list.
 */
export const MCP_CONNECTION_TOOLS_QUERY_KEY = [
  "integrations",
  "mcp",
  "connection",
  "tools",
] as const;

type McpConnectionRoute = ReturnType<typeof client.api.integrations.mcp.connections>;

/**
 * One page of a connection's persisted catalog, and the exact descriptor read
 * behind a hit. Both are derived from the routes rather than restated, so the
 * panel cannot drift from the wire contract; the route re-parses each arm at
 * its own boundary.
 */
export type McpConnectionToolPage = EdenData<McpConnectionRoute["tools"]["get"]>;

export type McpConnectionTool = McpConnectionToolPage["tools"][number];

export type McpConnectionToolInspection = EdenData<McpConnectionRoute["tools"]["inspect"]["get"]>;

/**
 * The consent door for a STORED connection, and the creation door for a
 * built-in that may have no row yet.
 *
 * Both are browser NAVIGATIONS, not fetches: they end at a third-party
 * authorization server. They are built here because three call sites used to
 * spell the same `${API_URL}/api/integrations/mcp/...` prefix by hand, and a
 * route rename would have missed one.
 */
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

/**
 * Build the synthetic "Connected" section that floats above the catalog
 * categories. Mirrors how the static catalog used to declare connected
 * tiles upfront, but driven by real `useResolvedIntegrations()` state
 * instead of hardcoded `status: "connected"` rows.
 */
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

/** Every operation across the loaded recovery pages, in page order. */
export function flattenMcpRecoveryPages(
  pages: ReadonlyArray<McpRecoveryOperationsPage> | undefined,
): ReadonlyArray<McpRecoveryOperation> {
  return pages?.flatMap((page) => page.operations) ?? [];
}
