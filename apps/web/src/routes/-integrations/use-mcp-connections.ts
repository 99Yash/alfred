import { useQuery } from "@tanstack/react-query";
import { client } from "~/lib/eden";
import { MCP_CONNECTIONS_QUERY_KEY, type McpConnection } from "./helpers";

/** The owner's MCP connections. The list section and a provider detail page share this read. */
export function useMcpConnections() {
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
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}
