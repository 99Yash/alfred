import { getStringPath } from "@alfred/contracts";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { AppButton, AppInput } from "~/components/ui/v2";
import { client } from "~/lib/eden";
import { cn } from "~/lib/utils";
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

/** One catalog row's identity: the list key, and the row that takes focus back from the detail. */
function toolKey(tool: { ref: SelectedToolRef }): string {
  return `${tool.ref.catalogRevision}:${tool.ref.remoteName}`;
}

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
    <div className="space-y-1 transition-opacity duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] starting:opacity-0">
      {title ? <p className="text-sm font-medium text-app-fg-4">{title}</p> : null}
      {title === name ? null : (
        <p
          className={cn(
            "font-mono",
            title ? "text-xs text-app-fg-2" : "text-[13px] font-medium text-app-fg-4",
          )}
        >
          {name}
        </p>
      )}
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
  /** The view's outer box, measured when a tool opens. */
  rootRef?: Ref<HTMLDivElement> | undefined;
  /** The list scroller, so "All tools" can restore its position. */
  listScrollRef?: Ref<HTMLDivElement> | undefined;
  /** The list's height when the tool opened; the detail never renders shorter. */
  detailMinHeight?: number | null | undefined;
  /** Slide the list in from the left: true only after "All tools", never on the modal's first open. */
  listEntersFromDetail?: boolean | undefined;
}

/** A drill-in or back swap: a short fade and an 8px slide, which reduced motion keeps as a fade. */
const VIEW_SWAP_CLASS =
  "transition-[opacity,translate] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] starting:opacity-0 motion-reduce:starting:translate-x-0";

/**
 * The catalog view without hooks, so `renderToStaticMarkup` reaches every state (no jsdom).
 * A non-ready status sits above the list, so a refused refresh never looks like "no tools" (ADR-0094).
 * A selected tool replaces the list with its detail; "All tools" goes back. The detail
 * keeps at least the list's height, so a short description does not collapse the centered
 * modal around it.
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
  rootRef,
  listScrollRef,
  detailMinHeight = null,
  listEntersFromDetail = false,
}: McpCatalogViewProps) {
  const statusLine =
    connectionStatus === "ready" ? null : (
      <p className="text-xs text-app-amber-4" role="status">
        {mcpConnectionStatusText({ status: connectionStatus, lastError: connectionLastError })}
      </p>
    );

  if (selectedRemoteName !== null) {
    return (
      // Distinct keys: React must mount a new root, or `@starting-style` never runs.
      <div
        key="detail"
        ref={rootRef}
        className={cn(
          "max-h-[70vh] space-y-4 overflow-y-auto px-6 pb-6",
          VIEW_SWAP_CLASS,
          "starting:translate-x-2",
        )}
        style={detailMinHeight === null ? undefined : { minHeight: detailMinHeight }}
      >
        <div className="flex items-center gap-2">
          <AppButton
            size="sm"
            variant="ghost"
            leading={<ChevronLeft size={12} />}
            onClick={onDismissInspection}
            className="-ml-2"
            data-catalog-back
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
    <div
      key="list"
      ref={rootRef}
      className={cn(
        "space-y-3 px-6 pb-6",
        listEntersFromDetail && [VIEW_SWAP_CLASS, "starting:-translate-x-2"],
      )}
    >
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
      <div ref={listScrollRef} className="scroll-stable -mx-3 max-h-[60vh] overflow-y-auto">
        {loading ? (
          <p className="p-3 text-xs text-app-fg-3" role="status">
            Loading tools…
          </p>
        ) : readError ? (
          <div className="flex items-center gap-2 p-3" role="alert">
            <p className="text-xs text-app-red-4">Could not load MCP tools.</p>
            <AppButton size="sm" variant="white" onClick={onRetry}>
              Retry
            </AppButton>
          </div>
        ) : tools.length === 0 ? (
          <p className="p-3 text-xs text-app-fg-3">
            {searchQuery.trim().length > 0
              ? `No tools match “${searchQuery.trim()}”.`
              : "No tools are published for this connection yet."}
          </p>
        ) : (
          <ul className="divide-y divide-app-bg-a2">
            {tools.map((tool) => (
              <li key={toolKey(tool)}>
                <button
                  type="button"
                  data-tool-key={toolKey(tool)}
                  onClick={() => onSelect(tool)}
                  className="group flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-left transition-colors outline-none hover:bg-app-bg-a2 focus-visible:bg-app-bg-a2"
                >
                  <span className="min-w-0 flex-1">
                    {/* The remote name is the identity the model calls; a title only labels it. */}
                    <span className="flex min-w-0 items-baseline gap-2">
                      {tool.title ? (
                        <span className="truncate text-[13px] font-medium text-app-fg-4">
                          {tool.title}
                        </span>
                      ) : null}
                      {tool.title === tool.ref.remoteName ? null : (
                        <code
                          className={cn(
                            "truncate font-mono",
                            tool.title
                              ? "shrink-2 text-[11px] text-app-fg-2"
                              : "text-[12.5px] font-medium text-app-fg-4",
                          )}
                        >
                          {tool.ref.remoteName}
                        </code>
                      )}
                    </span>
                    {tool.description ? (
                      <span className="mt-0.5 block truncate text-xs text-app-fg-3">
                        {tool.description}
                      </span>
                    ) : null}
                  </span>
                  <ChevronRight
                    size={14}
                    aria-hidden
                    className="shrink-0 text-app-fg-2 transition-[translate,color] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:translate-x-0.5 group-hover:text-app-fg-4 group-focus-visible:text-app-fg-4 motion-reduce:group-hover:translate-x-0"
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
        {hasNextPage ? (
          <div className="flex justify-center px-3 py-2">
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
  const [detailMinHeight, setDetailMinHeight] = useState<number | null>(null);
  const [returnedFromDetail, setReturnedFromDetail] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const listScrollTop = useRef(0);
  const returnFocusKey = useRef<string | null>(null);
  const connectionId = connection.id;

  // Each swap unmounts the focused button. Before paint, put the list back where the
  // user left it, and move focus to the row they opened or to "All tools".
  useLayoutEffect(() => {
    const root = rootRef.current;

    if (selected !== null) {
      root?.querySelector<HTMLElement>("[data-catalog-back]")?.focus({ preventScroll: true });

      return;
    }

    if (listScrollRef.current) listScrollRef.current.scrollTop = listScrollTop.current;

    const key = returnFocusKey.current;

    if (key !== null) {
      root
        ?.querySelector<HTMLElement>(`[data-tool-key="${CSS.escape(key)}"]`)
        ?.focus({ preventScroll: true });
    }
  }, [selected]);

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
      onSelect={(tool) => {
        listScrollTop.current = listScrollRef.current?.scrollTop ?? 0;
        returnFocusKey.current = toolKey(tool);
        setDetailMinHeight(rootRef.current?.offsetHeight ?? null);
        setSelected({
          remoteName: tool.ref.remoteName,
          catalogRevision: tool.ref.catalogRevision,
        });
      }}
      onDismissInspection={() => {
        setReturnedFromDetail(true);
        setSelected(null);
      }}
      rootRef={rootRef}
      listScrollRef={listScrollRef}
      detailMinHeight={detailMinHeight}
      listEntersFromDetail={returnedFromDetail}
    />
  );
}
