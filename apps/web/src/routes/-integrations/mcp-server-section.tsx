import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MCP_BUILT_IN_PROVIDERS,
  type McpRecoveryDecision,
  type McpRecoveryOperationsPage,
} from "@alfred/contracts";
import { client, type EdenData } from "~/lib/eden";
import { flattenMcpRecoveryPages, MCP_CONNECTIONS_QUERY_KEY, MCP_SECTION } from "./helpers";
import { McpAddServerForm } from "./mcp-add-server-form";
import { McpBuiltInCard } from "./mcp-built-in-card";
import { McpConnectionCard } from "./mcp-connection-card";
import { McpRecoveryList } from "./mcp-recovery-list";

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
    queryKey: MCP_CONNECTIONS_QUERY_KEY,
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

  // `builtInProvider` is derived server-side from the pinned endpoint, so a tile
  // follows its built-in when that endpoint moves. The old test was
  // `canonicalResource.includes("github")`, which also matched a user-added URL
  // that merely had "github" in it, and broke on any endpoint rename.
  //
  // NULL is the whole test for a generic card. Naming the built-ins here
  // instead would silently demote every future first-class server into the
  // generic list, which offers no consent action.
  const genericConnections = connections.filter(
    (connection) => connection.builtInProvider === null,
  );

  return (
    <section className="app-card-in space-y-3" style={{ animationDelay: `${480}ms` }}>
      <h2 className="px-1 text-xs font-medium tracking-tight text-app-fg-2 uppercase">
        {MCP_SECTION.heading}
      </h2>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
        {MCP_BUILT_IN_PROVIDERS.map((provider) => (
          <McpBuiltInCard
            key={provider}
            provider={provider}
            connection={connections.find((connection) => connection.builtInProvider === provider)}
            loading={connectionQuery.isPending}
            readError={connectionQuery.isError}
            onRetry={() => {
              void connectionQuery.refetch();
            }}
          />
        ))}

        {genericConnections.map((connection) => (
          <McpConnectionCard key={connection.id} connection={connection} />
        ))}

        <McpAddServerForm />
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
