import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { McpRecoveryDecision, McpRecoveryOperationsPage } from "@alfred/contracts";
import { AlertTriangle, Plug, Plus } from "lucide-react";
import { AppCard } from "~/components/ui/v2";
import { client, type EdenData, API_URL } from "~/lib/eden";
import { flattenMcpRecoveryPages, MCP_SECTION } from "./helpers";
import { McpRecoveryList } from "./mcp-recovery-list";
import { mcpConnectionStatusText } from "./mcp-server-status";

type McpConnectionsResponse = EdenData<typeof client.api.integrations.mcp.connections.get>;
type McpConnection = McpConnectionsResponse["connections"][number];
type McpRecoveryAction =
  | {
      kind: "resolve";
      invocationId: string;
      decision: McpRecoveryDecision;
    }
  | { kind: "successor"; invocationId: string };

const FIRST_RECOVERY_PAGE: string | null = null;

export function MCPServerSection() {
  const queryClient = useQueryClient();
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
  const recoveryQuery = useInfiniteQuery({
    queryKey: ["integrations", "mcp", "recovery"],
    queryFn: async ({ pageParam }: { pageParam: string | null }) => {
      const response = await client.api.integrations.mcp.recovery.get({
        query: pageParam ? { cursor: pageParam } : {},
      });
      if (response.error || !response.data) {
        throw new Error("Could not load MCP recovery operations");
      }
      return response.data;
    },
    initialPageParam: FIRST_RECOVERY_PAGE,
    getNextPageParam: (lastPage: McpRecoveryOperationsPage) => lastPage.nextCursor,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
  const recoveryMutation = useMutation({
    mutationFn: async (action: McpRecoveryAction) => {
      const route = client.api.integrations.mcp.recovery({
        invocationId: action.invocationId,
      });
      const response =
        action.kind === "successor"
          ? await route.successor.post()
          : await route.resolve.post({ decision: action.decision });
      if (response.error || !response.data) {
        throw new Error("Could not update the MCP recovery operation");
      }
      return response.data;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["integrations", "mcp", "recovery"] }),
  });
  const recoveryOperations = flattenMcpRecoveryPages(recoveryQuery.data?.pages);
  // Every page reports the same owner-wide count; the newest page is the freshest.
  const awaitingRepair = recoveryQuery.data?.pages.at(-1)?.awaitingRepair ?? 0;
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
      <McpRecoveryList
        operations={recoveryOperations}
        awaitingRepair={awaitingRepair}
        loading={recoveryQuery.isPending}
        readError={recoveryQuery.isError}
        hasNextPage={recoveryQuery.hasNextPage}
        loadingMore={recoveryQuery.isFetchingNextPage}
        mutationPending={recoveryMutation.isPending}
        mutationError={recoveryMutation.isError}
        onReadRetry={() => {
          void recoveryQuery.refetch();
        }}
        onLoadMore={() => {
          void recoveryQuery.fetchNextPage();
        }}
        onResolve={(invocationId, decision) => {
          recoveryMutation.mutate({ kind: "resolve", invocationId, decision });
        }}
        onRetry={(invocationId) => {
          recoveryMutation.mutate({ kind: "successor", invocationId });
        }}
      />
    </section>
  );
}
