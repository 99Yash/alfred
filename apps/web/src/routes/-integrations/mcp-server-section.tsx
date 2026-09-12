import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  toMessage,
  type McpRecoveryDecision,
  type McpRecoveryOperationsPage,
} from "@alfred/contracts";
import { AlertTriangle, Plug, Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { AppButton, AppCard, AppInput } from "~/components/ui/v2";
import { responseErrorMessage } from "~/lib/api-error";
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

const CONNECTIONS_QUERY_KEY = ["integrations", "mcp", "connections"] as const;

/**
 * Status text plus the published tool count once a revision exists. The count
 * is the one fact a fresh no-auth connection can report without a call, so it
 * is folded into the same line rather than a second field.
 */
function connectionSubtitle(connection: McpConnection): string {
  const status = mcpConnectionStatusText(connection);

  if (connection.status !== "ready" || connection.toolCount === null) return status;

  return `${status} · ${connection.toolCount} ${connection.toolCount === 1 ? "tool" : "tools"}`;
}

/** One connection tile: leading icon, label/subtitle, and the caller's actions. */
function ConnectionCard({
  icon,
  label,
  subtitle,
  children,
}: {
  icon: ReactNode;
  label: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <AppCard padded={false} className="flex items-center gap-3 px-3 py-2.5">
      <span
        className="grid size-9 shrink-0 place-items-center rounded-xl bg-app-bg-2 text-app-fg-3 ring-1 ring-app-bg-3"
        aria-hidden
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-app-fg-4">{label}</p>
        <p className="truncate text-xs text-app-fg-3">{subtitle}</p>
      </div>
      {children}
    </AppCard>
  );
}

export function MCPServerSection() {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [endpointUrl, setEndpointUrl] = useState("");
  const [label, setLabel] = useState("");

  const [addNotice, setAddNotice] = useState<{
    kind: "auth_required" | "error";
    message: string;
  } | null>(null);

  const connectionQuery = useQuery<ReadonlyArray<McpConnection>>({
    queryKey: CONNECTIONS_QUERY_KEY,
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

  const addMutation = useMutation({
    mutationFn: async (input: { endpointUrl: string; label?: string }) => {
      const response = await client.api.integrations.mcp.connections.post(input);

      if (response.error) {
        throw new Error(
          responseErrorMessage(response.error.value, response.error.status, "Add MCP server"),
        );
      }

      if (!response.data) throw new Error("Add MCP server failed");

      return response.data;
    },
    onSuccess: (data) => {
      if (data.outcome === "auth_required") {
        // No rows were created; the server answered with a sign-in challenge,
        // which this slice does not support. The message is the whole state.
        setAddNotice({
          kind: "auth_required",
          message: "This server requires sign-in, which is not supported yet.",
        });

        return;
      }

      setEndpointUrl("");
      setLabel("");
      setAddNotice(null);
      setAddOpen(false);
      void queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY });
    },
    onError: (error) => {
      setAddNotice({ kind: "error", message: toMessage(error) });
    },
  });

  const reconnectMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await client.api.integrations.mcp.connections({ id }).reconnect.post();

      if (response.error) {
        throw new Error(
          responseErrorMessage(response.error.value, response.error.status, "Reconnect MCP server"),
        );
      }

      return response.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY }),
  });

  const disconnectMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await client.api.integrations.mcp.connections({ id }).disconnect.post();

      if (response.error) {
        throw new Error(
          responseErrorMessage(
            response.error.value,
            response.error.status,
            "Disconnect MCP server",
          ),
        );
      }

      return response.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY }),
  });

  const recoveryOperations = flattenMcpRecoveryPages(recoveryQuery.data?.pages);
  // Every page reports the same owner-wide count; the newest page is the freshest.
  const awaitingRepair = recoveryQuery.data?.pages.at(-1)?.awaitingRepair ?? 0;
  // `builtInProvider` is derived server-side from the pinned endpoint, so the
  // card follows the built-in when its path moves. The old
  // `canonicalResource.includes("github")` also matched a user-added URL that
  // merely had "github" in it, and broke on any endpoint rename.
  const github = connections.find((connection) => connection.builtInProvider === "github");

  const genericConnections = connections.filter(
    (connection) => connection.builtInProvider !== "github",
  );

  const isConnecting = github?.status === "connecting";

  const githubStatusText = connectionQuery.isPending
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
        <ConnectionCard
          icon={<Plug size={18} />}
          label={github?.label ?? "GitHub MCP"}
          subtitle={githubStatusText}
        >
          <AppButton
            size="sm"
            variant="white"
            leading={
              github?.status === "auth_required" ? <AlertTriangle size={12} /> : <Plus size={12} />
            }
            disabled={connectionQuery.isPending || isConnecting}
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
          >
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
          </AppButton>
        </ConnectionCard>

        {genericConnections.map((connection) => (
          <ConnectionCard
            key={connection.id}
            icon={<Plug size={18} />}
            label={connection.label}
            subtitle={connectionSubtitle(connection)}
          >
            <div className="flex shrink-0 items-center gap-1">
              <AppButton
                size="sm"
                variant="ghost"
                loading={
                  reconnectMutation.isPending && reconnectMutation.variables === connection.id
                }
                onClick={() => reconnectMutation.mutate(connection.id)}
              >
                {connection.status === "disconnected" ? "Connect" : "Reconnect"}
              </AppButton>
              {connection.status !== "disconnected" ? (
                <AppButton
                  size="sm"
                  variant="ghost"
                  loading={
                    disconnectMutation.isPending && disconnectMutation.variables === connection.id
                  }
                  onClick={() => disconnectMutation.mutate(connection.id)}
                >
                  Disconnect
                </AppButton>
              ) : null}
            </div>
          </ConnectionCard>
        ))}

        <ConnectionCard
          icon={<Plus size={18} />}
          label={MCP_SECTION.name}
          subtitle={MCP_SECTION.description}
        >
          <AppButton
            size="sm"
            variant="white"
            onClick={() => {
              setAddOpen((open) => !open);
              setAddNotice(null);
            }}
          >
            {addOpen ? "Close" : "Add"}
          </AppButton>
        </ConnectionCard>
      </div>

      {addOpen ? (
        <form
          className="flex flex-col gap-2 rounded-2xl bg-app-bg-2 p-3 ring-1 ring-app-bg-3 sm:flex-row sm:items-center"
          onSubmit={(event) => {
            event.preventDefault();
            setAddNotice(null);
            addMutation.mutate({
              endpointUrl: endpointUrl.trim(),
              ...(label.trim() ? { label: label.trim() } : {}),
            });
          }}
        >
          <AppInput
            type="url"
            required
            placeholder="https://mcp.example.com/mcp"
            value={endpointUrl}
            onChange={(event) => setEndpointUrl(event.target.value)}
            aria-label="MCP server URL"
            className="flex-1"
          />
          <AppInput
            placeholder="Label (optional)"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            aria-label="MCP server label"
            className="sm:w-48"
          />
          <AppButton
            type="submit"
            variant="primary"
            loading={addMutation.isPending}
            disabled={endpointUrl.trim().length === 0}
          >
            Add server
          </AppButton>
        </form>
      ) : null}

      {addNotice ? (
        <p
          className={
            addNotice.kind === "auth_required"
              ? "px-1 text-xs text-app-fg-3"
              : "px-1 text-xs text-app-red-4"
          }
          role="status"
        >
          {addNotice.message}
        </p>
      ) : null}

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
