import { getStringPath } from "@alfred/contracts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AppButton, AppCard } from "~/components/ui/v2";
import { client } from "~/lib/eden";
import {
  MCP_CONNECTION_TOOLS_QUERY_KEY,
  type McpConnection,
  type McpConnectionTool,
  type McpConnectionToolInspection,
} from "./helpers";
import { mcpConnectionStatusText } from "./mcp-server-status";

type SelectedToolRef = { readonly remoteName: string; readonly catalogRevision: string };

/**
 * The one exact descriptor behind a selected hit.
 *
 * The descriptor is a `JsonObject` off the wire, so its named fields are read
 * with `getStringPath` and rendered as text. The raw object is never dumped as
 * markup: a server controls that object, and rendering it whole would let it
 * choose the page's shape.
 */
function McpInspectionDetail({
  inspection,
  onDismiss,
}: {
  inspection: McpConnectionToolInspection;
  onDismiss: () => void;
}) {
  if (inspection.status !== "tool") {
    // Both `not_found` and `catalog_stale` are refusals, not empty catalogs.
    // They name the reason and leave the list in place; the owner refreshes by
    // reopening the panel rather than reading a silently filtered list.
    return (
      <div className="space-y-2 rounded-lg bg-app-bg-2 p-2" role="alert">
        <p className="text-xs text-app-fg-3">{inspection.message}</p>
        <AppButton size="sm" variant="white" onClick={onDismiss}>
          Back to tools
        </AppButton>
      </div>
    );
  }

  const name = getStringPath(inspection.tool, "name") ?? inspection.ref.remoteName;
  const title = getStringPath(inspection.tool, "title");
  const description = getStringPath(inspection.tool, "description");

  return (
    <div className="space-y-1 rounded-lg bg-app-bg-2 p-2">
      <p className="text-xs font-medium text-app-fg-4">{title ?? name}</p>
      <p className="text-xs text-app-fg-2">{name}</p>
      {description ? <p className="text-xs text-app-fg-3">{description}</p> : null}
      <AppButton size="sm" variant="ghost" onClick={onDismiss}>
        Close
      </AppButton>
    </div>
  );
}

export interface McpCatalogViewProps {
  /** The connection's persisted status, rendered above every list. */
  connectionStatus: McpConnection["status"];
  connectionLastError: string | null;
  loading: boolean;
  readError: boolean;
  tools: ReadonlyArray<McpConnectionTool>;
  hasNextPage: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  selectedRemoteName: string | null;
  inspection: McpConnectionToolInspection | null;
  inspectionLoading: boolean;
  onSelect: (tool: McpConnectionTool) => void;
  onDismissInspection: () => void;
}

/**
 * The catalog panel's presentation, without hooks.
 *
 * The container below owns the two reads; this half renders them, so the
 * loading / error / empty / populated states and every inspection arm are
 * reachable from `renderToStaticMarkup` (apps/web has no jsdom). The persisted
 * status and `lastError` sit ABOVE the list on purpose: a connection whose last
 * refresh was refused must not read as a quiet "no tools yet" (ADR-0094).
 */
export function McpCatalogView({
  connectionStatus,
  connectionLastError,
  loading,
  readError,
  tools,
  hasNextPage,
  loadingMore,
  onLoadMore,
  onRetry,
  selectedRemoteName,
  inspection,
  inspectionLoading,
  onSelect,
  onDismissInspection,
}: McpCatalogViewProps) {
  const statusText = mcpConnectionStatusText({
    status: connectionStatus,
    lastError: connectionLastError,
  });

  return (
    <AppCard padded className="space-y-3">
      <div className="space-y-1">
        <p className="text-xs font-medium text-app-fg-4">Tools</p>
        <p className="text-xs text-app-fg-3" role="status">
          {statusText}
        </p>
      </div>

      {inspectionLoading ? (
        <p className="text-xs text-app-fg-3" role="status">
          Loading tool…
        </p>
      ) : inspection ? (
        <McpInspectionDetail inspection={inspection} onDismiss={onDismissInspection} />
      ) : null}

      {loading ? (
        <p className="text-xs text-app-fg-3" role="status">
          Loading tools…
        </p>
      ) : readError ? (
        <div className="flex items-center gap-2" role="alert">
          <p className="text-xs text-red-600">Could not load MCP tools.</p>
          <AppButton size="sm" variant="white" onClick={onRetry}>
            Retry
          </AppButton>
        </div>
      ) : tools.length === 0 ? (
        <p className="text-xs text-app-fg-3">No tools are published for this connection yet.</p>
      ) : (
        <ul className="space-y-1">
          {tools.map((tool) => {
            const selected = selectedRemoteName === tool.ref.remoteName;

            return (
              <li
                key={`${tool.ref.catalogRevision}:${tool.ref.remoteName}`}
                className="flex items-start justify-between gap-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-app-fg-4">
                    {tool.title ?? tool.ref.remoteName}
                  </p>
                  <p className="truncate text-xs text-app-fg-2">{tool.ref.remoteName}</p>
                  {tool.description ? (
                    <p className="text-xs text-app-fg-3">{tool.description}</p>
                  ) : null}
                </div>
                <AppButton
                  size="sm"
                  variant={selected ? "primary" : "white"}
                  onClick={() => onSelect(tool)}
                >
                  {selected ? "Selected" : "Inspect"}
                </AppButton>
              </li>
            );
          })}
        </ul>
      )}

      {hasNextPage ? (
        <AppButton size="sm" variant="white" disabled={loadingMore} onClick={onLoadMore}>
          {loadingMore ? "Loading more…" : "Load more"}
        </AppButton>
      ) : null}
    </AppCard>
  );
}

/**
 * One generic connection's persisted catalog.
 *
 * Two reads: a cursor page over the connection's tool list, and one exact
 * descriptor for the selected hit. Both are scoped to `connection.id` at the
 * route, so the panel cannot read another owner's catalog. The panel is mounted
 * only for `builtInProvider === null` rows (the card that owns it), so a
 * built-in's refused refresh keeps its own policy semantics (ADR-0094).
 */
export function McpConnectionCatalogPanel({ connection }: { connection: McpConnection }) {
  const [selected, setSelected] = useState<SelectedToolRef | null>(null);
  const connectionId = connection.id;

  const toolsQuery = useInfiniteQuery({
    queryKey: [...MCP_CONNECTION_TOOLS_QUERY_KEY, connectionId],
    queryFn: async ({ pageParam }: { pageParam: string | null }) => {
      const response = await client.api.integrations.mcp
        .connections({ id: connectionId })
        .tools.get({ query: pageParam ? { cursor: pageParam } : {} });

      if (response.error || !response.data) {
        throw new Error("Could not load MCP tools");
      }

      return response.data;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 15_000,
  });

  const inspectQuery = useQuery({
    queryKey: [
      ...MCP_CONNECTION_TOOLS_QUERY_KEY,
      connectionId,
      "inspect",
      selected?.remoteName ?? null,
      selected?.catalogRevision ?? null,
    ],
    enabled: selected !== null,
    queryFn: async () => {
      if (!selected) throw new Error("No MCP tool selected");

      const response = await client.api.integrations.mcp
        .connections({ id: connectionId })
        .tools.inspect.get({ query: selected });

      if (response.error || !response.data) {
        throw new Error("Could not load MCP tool");
      }

      return response.data;
    },
  });

  const tools = toolsQuery.data?.pages.flatMap((page) => page.tools) ?? [];

  return (
    <McpCatalogView
      connectionStatus={connection.status}
      connectionLastError={connection.lastError}
      loading={toolsQuery.isPending}
      readError={toolsQuery.isError}
      tools={tools}
      hasNextPage={toolsQuery.hasNextPage}
      loadingMore={toolsQuery.isFetchingNextPage}
      onLoadMore={() => {
        void toolsQuery.fetchNextPage();
      }}
      onRetry={() => {
        void toolsQuery.refetch();
      }}
      selectedRemoteName={selected?.remoteName ?? null}
      inspection={inspectQuery.data ?? null}
      inspectionLoading={inspectQuery.isFetching}
      onSelect={(tool) =>
        setSelected({
          remoteName: tool.ref.remoteName,
          catalogRevision: tool.ref.catalogRevision,
        })
      }
      onDismissInspection={() => setSelected(null)}
    />
  );
}
