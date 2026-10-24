import { getStringPath } from "@alfred/contracts";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { AppButton, AppInput } from "~/components/ui/v2";
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

/** Wait this long after the last key before the catalog search asks the server. */
const SEARCH_DEBOUNCE_MS = 200;

/** Server-controlled JSON: read named fields as text, never render the object whole. */
function McpInspectionDetail({ inspection }: { inspection: McpConnectionToolInspection }) {
  if (inspection.status !== "tool") {
    // `not_found` and `catalog_stale` are refusals, not empty catalogs; say why.
    return (
      <p className="rounded-control bg-app-bg-2 p-3 text-xs text-app-fg-3" role="alert">
        {inspection.message}
      </p>
    );
  }

  const name = getStringPath(inspection.tool, "name") ?? inspection.ref.remoteName;
  const title = getStringPath(inspection.tool, "title");
  const description = getStringPath(inspection.tool, "description");

  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-app-fg-4">{title ?? name}</p>
      {title && title !== name ? <p className="text-xs text-app-fg-2">{name}</p> : null}
      {description ? (
        <p className="text-[13px] leading-5 whitespace-pre-wrap text-app-fg-3">{description}</p>
      ) : null}
    </div>
  );
}

export interface McpCatalogViewProps {
  connectionStatus: McpConnection["status"];
  connectionLastError: string | null;
  searchQuery: string;
  onSearchChange: (query: string) => void;
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
 * A non-ready status sits above the list, so a refused refresh never looks like "no tools" (ADR-0094).
 * A selected tool replaces the list with its detail; "All tools" goes back.
 */
export function McpCatalogView({
  connectionStatus,
  connectionLastError,
  searchQuery,
  onSearchChange,
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
  const statusLine =
    connectionStatus === "ready" ? null : (
      <p className="text-xs text-app-amber-4" role="status">
        {mcpConnectionStatusText({ status: connectionStatus, lastError: connectionLastError })}
      </p>
    );

  if (selectedRemoteName !== null) {
    return (
      <div className="max-h-[70vh] space-y-4 overflow-y-auto px-6 pb-6">
        <div className="flex items-center gap-2">
          <AppButton
            size="sm"
            variant="ghost"
            leading={<ChevronLeft size={12} />}
            onClick={onDismissInspection}
          >
            All tools
          </AppButton>
          {/* The resolved descriptor names itself below; until then, name the selection here. */}
          {inspection?.status === "tool" ? null : (
            <span className="truncate text-xs text-app-fg-2">{selectedRemoteName}</span>
          )}
        </div>
        {statusLine}
        {inspectionLoading ? (
          <p className="text-xs text-app-fg-3" role="status">
            Loading tool…
          </p>
        ) : inspection ? (
          <>
            <McpInspectionDetail inspection={inspection} />
            {policyReview}
            {healthMappingReview}
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3 px-6 pb-6">
      <div className="relative">
        <Search
          size={14}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-app-fg-2"
          aria-hidden
        />
        <AppInput
          placeholder="Search tools"
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          className="w-full !pl-9"
          aria-label="Search tools"
        />
      </div>
      {statusLine}
      <div className="scroll-stable -mx-2 max-h-[60vh] overflow-y-auto">
        {loading ? (
          <p className="px-2 py-3 text-xs text-app-fg-3" role="status">
            Loading tools…
          </p>
        ) : readError ? (
          <div className="flex items-center gap-2 px-2 py-3" role="alert">
            <p className="text-xs text-app-red-4">Could not load MCP tools.</p>
            <AppButton size="sm" variant="white" onClick={onRetry}>
              Retry
            </AppButton>
          </div>
        ) : tools.length === 0 ? (
          <p className="px-2 py-3 text-xs text-app-fg-3">
            {searchQuery.trim().length > 0
              ? `No tools match “${searchQuery.trim()}”.`
              : "No tools are published for this connection yet."}
          </p>
        ) : (
          <ul>
            {tools.map((tool) => (
              <li key={`${tool.ref.catalogRevision}:${tool.ref.remoteName}`}>
                <button
                  type="button"
                  onClick={() => onSelect(tool)}
                  className="group flex w-full items-center gap-3 rounded-control p-2 text-left outline-none hover:bg-app-bg-a2 focus-visible:bg-app-bg-a2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-app-fg-4">
                      {tool.title ?? tool.ref.remoteName}
                    </span>
                    {tool.title && tool.title !== tool.ref.remoteName ? (
                      <span className="block truncate text-xs text-app-fg-2">
                        {tool.ref.remoteName}
                      </span>
                    ) : null}
                    {tool.description ? (
                      <span className="mt-0.5 line-clamp-2 text-xs text-app-fg-3">
                        {tool.description}
                      </span>
                    ) : null}
                  </span>
                  <ChevronRight
                    size={14}
                    aria-hidden
                    className="shrink-0 text-app-fg-2 group-hover:text-app-fg-4"
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
        {hasNextPage ? (
          <div className="flex justify-center px-2 pt-2">
            <AppButton size="sm" variant="ghost" disabled={loadingMore} onClick={onLoadMore}>
              {loadingMore ? "Loading more…" : "Load more"}
            </AppButton>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One connection's catalog: a searchable tool page and one exact descriptor, both
 * scoped to `connection.id`. The routes read the stored catalog only, so a built-in
 * whose refresh was refused (ADR-0094) shows its status above the last published list.
 */
export function McpConnectionCatalogPanel({ connection }: { connection: McpConnection }) {
  const [selected, setSelected] = useState<SelectedToolRef | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const connectionId = connection.id;

  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedQuery(searchQuery.trim()),
      SEARCH_DEBOUNCE_MS,
    );

    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const toolsQuery = useInfiniteQuery({
    queryKey: [...MCP_CONNECTION_TOOLS_QUERY_KEY, connectionId, debouncedQuery],
    queryFn: async ({ pageParam }: { pageParam: string | null }) => {
      const response = await client.api.integrations.mcp
        .connections({ id: connectionId })
        .tools.get({
          query: {
            ...(pageParam ? { cursor: pageParam } : {}),
            ...(debouncedQuery ? { query: debouncedQuery } : {}),
          },
        });

      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Eden treaty `data` is the server's JSON typed by its route, not parsed here; an empty body or a skewed deploy can leave it null.
      if (response.error || !response.data) {
        throw new Error("Could not load MCP tools");
      }

      return response.data;
    },
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    // Keep the last list while a new search loads, so the list does not flash empty.
    placeholderData: keepPreviousData,
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

      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Eden treaty `data` is the server's JSON typed by its route, not parsed here; an empty body or a skewed deploy can leave it null.
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
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
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
