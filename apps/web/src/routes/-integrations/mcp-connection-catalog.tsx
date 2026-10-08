import { getStringPath } from "@alfred/contracts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { AppButton, AppCard } from "~/components/ui/v2";
import { client } from "~/lib/eden";
import {
  MCP_CONNECTION_TOOLS_QUERY_KEY,
  type McpConnection,
  type McpConnectionTool,
  type McpConnectionToolInspection,
} from "./helpers";
import { mcpConnectionStatusText } from "./mcp-server-status";
import { McpHealthMappingReview } from "./mcp-health-mapping";
import { McpToolPolicyReview } from "./mcp-tool-policy";

type SelectedToolRef = { readonly remoteName: string; readonly catalogRevision: string };

/** Server-controlled JSON: read named fields as text, never render the object whole. */
function McpInspectionDetail({
  inspection,
  onDismiss,
}: {
  inspection: McpConnectionToolInspection;
  onDismiss: () => void;
}) {
  if (inspection.status !== "tool") {
    // `not_found` and `catalog_stale` are refusals, not empty catalogs; say why.
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
  /** Review surface for the selected tool, or null. A node, so this view stays hook-free. */
  policyReview: ReactNode;
  healthMappingReview: ReactNode;
  onSelect: (tool: McpConnectionTool) => void;
  onDismissInspection: () => void;
}

/**
 * The catalog view without hooks, so `renderToStaticMarkup` reaches every state (no jsdom).
 * Status and `lastError` sit above the list, so a refused refresh never looks like "no tools" (ADR-0094).
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
  policyReview,
  healthMappingReview,
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

      {policyReview}
      {healthMappingReview}

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
 * One generic connection's catalog: a tool page and one exact descriptor, both
 * scoped to `connection.id`. Generic rows only, so a built-in keeps its own
 * refusal semantics (ADR-0094).
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
    initialPageParam: null,
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
  const inspection = inspectQuery.data ?? null;

  // Only a resolved descriptor gets a review; a refusal is the whole surface.
  const policyReview =
    inspection?.status === "tool" ? (
      // Key by tool identity: tools in the same policy state would share form
      // state, and Save would write one tool's draft under another's hash.
      <McpToolPolicyReview
        key={`${inspection.ref.remoteName}:${inspection.ref.catalogRevision}`}
        connectionId={connectionId}
        toolRef={inspection.ref}
      />
    ) : null;

  const healthMappingReview =
    inspection?.status === "tool" ? (
      <McpHealthMappingReview
        key={`${inspection.ref.remoteName}:${inspection.ref.catalogRevision}`}
        connectionId={connectionId}
        toolRef={inspection.ref}
      />
    ) : null;

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
      inspection={inspection}
      inspectionLoading={inspectQuery.isFetching}
      policyReview={policyReview}
      healthMappingReview={healthMappingReview}
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
