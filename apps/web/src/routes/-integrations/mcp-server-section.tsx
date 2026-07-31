import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Plug, Plus } from "lucide-react";
import { AppCard } from "~/components/ui/v2";
import { client, type EdenData } from "~/lib/eden";
import { MCP_SECTION } from "./helpers";
import { mcpConnectionStatusText } from "./mcp-server-status";

const API_URL =
  (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? "http://localhost:3001";

type McpConnectionsResponse = EdenData<typeof client.api.integrations.mcp.connections.get>;
type McpConnection = McpConnectionsResponse["connections"][number];

export function MCPServerSection() {
  const connectionQuery = useQuery<ReadonlyArray<McpConnection>>({
    queryKey: ["integrations", "mcp", "connections"],
    queryFn: async () => {
      const response = await client.api.integrations.mcp.connections.get();
      if (response.error || !response.data) {
        throw new Error("Could not load MCP connections");
      }
      return response.data.connections;
    },
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
  const connections = connectionQuery.data ?? [];
  const github = connections.find((connection) => connection.canonicalResource.includes("github"));
  const isConnecting = github?.status === "connecting";
  const statusText = connectionQuery.isPending
    ? "Loading connection…"
    : connectionQuery.isError
      ? "Could not load connection status."
      : mcpConnectionStatusText(github);

  return (
    <section className="app-card-in space-y-3" style={{ animationDelay: `${480}ms` }}>
      <h2 className="px-1 text-xs font-medium tracking-tight text-app-fg-2 uppercase">
        {MCP_SECTION.heading}
      </h2>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
        <AppCard padded={false} className="flex items-center gap-3 px-3 py-2.5">
          <span
            className="grid size-9 shrink-0 place-items-center rounded-xl bg-app-bg-2 text-app-fg-3 ring-1 ring-app-bg-3"
            aria-hidden
          >
            <Plug size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-app-fg-4">
              {github?.label ?? "GitHub MCP"}
            </p>
            <p className="truncate text-xs text-app-fg-3">{statusText}</p>
          </div>
          <button
            type="button"
            className="inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-lg bg-app-bg-2 px-2.5 text-xs font-medium text-app-fg-2 hover:text-app-fg-4"
            onClick={() => {
              if (connectionQuery.isError) {
                void connectionQuery.refetch();
                return;
              }
              window.location.href =
                github?.status === "auth_required"
                  ? `${API_URL}/api/integrations/mcp/connections/${github.id}/reconsent`
                  : `${API_URL}/api/integrations/mcp/github/connect`;
            }}
            disabled={connectionQuery.isPending || isConnecting}
          >
            {github?.status === "auth_required" ? <AlertTriangle size={12} /> : <Plus size={12} />}
            {connectionQuery.isPending
              ? "Loading"
              : connectionQuery.isError
                ? "Retry"
                : isConnecting
                  ? "Connecting"
                  : github?.status === "auth_required"
                    ? "Grant access"
                    : github
                      ? "Reconnect"
                      : "Add"}
          </button>
        </AppCard>
      </div>
    </section>
  );
}
