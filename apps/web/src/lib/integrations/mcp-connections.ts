import { useQuery } from "@tanstack/react-query";
import { client, type EdenData } from "~/lib/eden";
import { domainOf } from "~/lib/favicon";

/** MCP connection list key. Each mutating component invalidates it itself; no refresh callback is passed down. */
export const MCP_CONNECTIONS_QUERY_KEY = ["integrations", "mcp", "connections"] as const;

type McpConnectionsResponse = EdenData<typeof client.api.integrations.mcp.connections.get>;

/** Derived from the route, so a new server field reaches every reader. */
export type McpConnection = McpConnectionsResponse["connections"][number];

/** The favicon host for a user-added server. `mcp.linear.app` has no icon of its own; the vendor site does. */
export function mcpConnectionFaviconDomain(
  connection: Pick<McpConnection, "endpointOrigin">,
): string {
  return domainOf(connection.endpointOrigin).replace(/^mcp\./, "");
}

/**
 * The owner's MCP connections. The integrations page and chat share this read.
 * `enabled: false` makes no request, so a surface can wait until it has a connection to name.
 */
export function useMcpConnections({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery<ReadonlyArray<McpConnection>>({
    queryKey: MCP_CONNECTIONS_QUERY_KEY,
    queryFn: async () => {
      const response = await client.api.integrations.mcp.connections.get();

      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Eden treaty `data` is the server's JSON typed by its route, not parsed here; an empty body or a skewed deploy can leave it null.
      if (response.error || !response.data) {
        throw new Error("Could not load MCP connections");
      }

      return response.data.connections;
    },
    enabled,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}
