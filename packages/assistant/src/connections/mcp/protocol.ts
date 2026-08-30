import {
  Client,
  MAX_CACHE_TTL_MS,
  ProtocolError,
  SdkHttpError,
  StreamableHTTPClientTransport,
  TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY,
  type AuthProvider,
  type CacheScope,
  type ClientCapabilities,
  type ProtocolEra,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import type { McpAuthorizedProtocol } from "./endpoint-authorization";
import type { McpTraceContext } from "./trace";

const HEADER_MISMATCH_ERROR_CODE = -32020;

/** Alfred offers no server-callable handlers and no Tasks capability. */
export const MCP_CLIENT_CAPABILITIES = Object.freeze({}) satisfies ClientCapabilities;
export const MCP_INPUT_REQUIRED_PROFILE = Object.freeze({ autoFulfill: false });

export type McpProtocolCallResult = Awaited<ReturnType<Client["callTool"]>>;

export interface McpProtocolPage {
  tools: Tool[];
  ttlMs: number;
  cacheScope: CacheScope;
  nextCursor?: string;
}

/**
 * The one catalog of SDK era, Alfred era, and admitted protocol revision. A new
 * SDK era is a compile error here, and every downstream union/allowlist derives
 * from this table instead of restating the correlation.
 */
const MCP_PROTOCOL_PROFILES = {
  legacy: {
    protocolEra: "pre_2026_07_28",
    protocolVersion: "2025-11-25",
  },
  modern: {
    protocolEra: "post_2026_07_28",
    protocolVersion: "2026-07-28",
  },
} as const satisfies Record<ProtocolEra, { protocolEra: string; protocolVersion: string }>;

type McpProtocolProfile = (typeof MCP_PROTOCOL_PROFILES)[ProtocolEra];
export type McpProtocolEra = McpProtocolProfile["protocolEra"];
export const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly McpProtocolProfile["protocolVersion"][] =
  Object.freeze(Object.values(MCP_PROTOCOL_PROFILES).map((profile) => profile.protocolVersion));
const MCP_SUPPORTED_PROTOCOL_VERSION_SET: ReadonlySet<string> = new Set(
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
);

export interface McpProtocolServer {
  protocolEra: McpProtocolEra;
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
  hasTools: boolean;
  toolsListChanged: boolean;
}

type McpServerFacts = Omit<McpProtocolServer, "protocolEra" | "protocolVersion">;

export type McpNegotiatedServer = McpServerFacts & McpProtocolProfile;

/**
 * The small protocol surface Alfred consumes. Keeping this interface below
 * the execution broker prevents SDK/session details from leaking into the
 * model-facing registry and makes the trust boundary deterministic to test.
 */
export interface McpProtocolClient {
  connect(trace?: McpTraceContext): Promise<McpProtocolServer>;
  close(terminateSession: boolean): Promise<void>;
  listTools(
    cursor: string | undefined,
    signal?: AbortSignal,
    trace?: McpTraceContext,
  ): Promise<McpProtocolPage>;
  callTool(
    tool: Tool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    trace?: McpTraceContext,
  ): Promise<McpProtocolCallResult>;
  onToolsChanged(handler: () => void | Promise<void>): void;
  onConnectionUnhealthy(handler: (error: Error) => void | Promise<void>): void;
}

export interface SdkMcpProtocolClientOptions {
  authorization: McpAuthorizedProtocol;
  authProvider?: AuthProvider;
  requestTimeoutMs: number;
}

/** Streamable HTTP implementation of Alfred's deliberately narrow MCP profile. */
export class SdkMcpProtocolClient implements McpProtocolClient {
  readonly #client: Client;
  readonly #transport: StreamableHTTPClientTransport;
  readonly #requestTimeoutMs: number;
  #toolsChangedHandler: (() => void | Promise<void>) | null = null;
  #connectionUnhealthyHandler: ((error: Error) => void | Promise<void>) | null = null;
  #closing = false;
  #connectTrace: McpTraceContext | undefined;

  constructor(options: SdkMcpProtocolClientOptions) {
    const authProvider = options.authProvider;
    // Empty capabilities are intentional: Alfred does not offer roots,
    // sampling, or elicitation to an untrusted remote server.
    this.#client = new Client(
      { name: "alfred", version: "1" },
      {
        capabilities: MCP_CLIENT_CAPABILITIES,
        enforceStrictCapabilities: true,
        versionNegotiation: { mode: "auto" },
        inputRequired: MCP_INPUT_REQUIRED_PROFILE,
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 0,
            onChanged: () => {
              void this.#toolsChangedHandler?.();
            },
          },
        },
      },
    );
    const fetchFn = options.authorization.fetch;
    this.#transport = new StreamableHTTPClientTransport(options.authorization.endpoint, {
      // Token reads are safe before each request. Transport-owned recovery is
      // not: both 401 refresh and insufficient-scope step-up resend the same
      // JSON-RPC message below Alfred's invocation ledger.
      ...(authProvider ? { authProvider: { token: () => authProvider.token() } } : {}),
      onInsufficientScope: "throw",
      fetch: (input, init) => {
        const connectTrace = this.#connectTrace;
        if (!connectTrace) return fetchFn(input, init);
        const headers = new Headers(init?.headers);
        headers.set("traceparent", connectTrace.traceparent);
        if (connectTrace.tracestate) headers.set("tracestate", connectTrace.tracestate);
        return fetchFn(input, { ...init, headers });
      },
    });
    this.#requestTimeoutMs = options.requestTimeoutMs;
  }

  onToolsChanged(handler: () => void | Promise<void>): void {
    this.#toolsChangedHandler = handler;
  }

  onConnectionUnhealthy(handler: (error: Error) => void | Promise<void>): void {
    this.#connectionUnhealthyHandler = handler;
  }

  async connect(trace?: McpTraceContext): Promise<McpProtocolServer> {
    this.#closing = false;
    this.#connectTrace = trace;
    // Third-party variance gap, not a claim about our types: the MCP SDK's own
    // transport classes declare `sessionId?: string | undefined` / `onclose?:
    // (() => void) | undefined` while its `Transport` interface declares those
    // keys narrow, so under `exactOptionalPropertyTypes` the SDK's class does
    // not structurally satisfy the SDK's own interface. Nothing on our side can
    // reconcile the two.
    try {
      await this.#client.connect(
        // SAFETY: our transport implements the MCP Transport interface; the
        // SDK ships its own wider nominal type for the same members.
        this.#transport as Transport,
        requestOptions(this.#requestTimeoutMs, undefined, trace),
      );
    } finally {
      this.#connectTrace = undefined;
    }
    const capabilities = this.#client.getServerCapabilities();
    const server = this.#client.getServerVersion();
    const protocolEra = this.#era();
    const protocolVersion = this.#client.getNegotiatedProtocolVersion();
    if (!protocolEra || !protocolVersion) {
      throw new Error("MCP SDK connected without a negotiated protocol era and version");
    }
    if (protocolEra === "post_2026_07_28" && capabilities?.tools?.listChanged === true) {
      const subscription = this.#client.autoOpenedSubscription;
      if (!subscription) {
        throw new Error(
          "MCP server advertised tools list changes, but the modern list-change subscription did not open",
        );
      }
      void subscription.closed.then((cause) => {
        if (this.#closing || cause === "local") return;
        void this.#connectionUnhealthyHandler?.(
          new Error(`MCP modern list-change subscription closed (${cause})`),
        );
      });
    }
    return {
      protocolEra,
      protocolVersion,
      serverName: server?.name ?? "unknown",
      serverVersion: server?.version ?? "unknown",
      hasTools: capabilities?.tools !== undefined,
      toolsListChanged: capabilities?.tools?.listChanged === true,
    };
  }

  #era(): McpProtocolEra | null {
    const era = this.#client.getProtocolEra();
    return era ? MCP_PROTOCOL_PROFILES[era].protocolEra : null;
  }

  async close(terminateSession: boolean): Promise<void> {
    this.#closing = true;
    if (terminateSession && this.#era() === "pre_2026_07_28" && this.#transport.sessionId) {
      try {
        await this.#transport.terminateSession();
      } catch {
        // Session deletion is optional in the protocol. Closing the transport
        // must still succeed when a server returns 405 or is already gone.
      }
    }
    await this.#client.close();
  }

  async listTools(
    cursor: string | undefined,
    signal?: AbortSignal,
    trace?: McpTraceContext,
  ): Promise<McpProtocolPage> {
    // `Client.listTools(undefined)` auto-aggregates and caches every page. Use
    // the request primitive so Alfred alone owns pagination, bounds, and the
    // immutable catalog that later calls are allowed to consume.
    const result = await this.#client.request(
      {
        method: "tools/list",
        params: {
          ...(cursor ? { cursor } : {}),
          ...(trace ? { _meta: traceMeta(trace) } : {}),
        },
      },
      requestOptions(this.#requestTimeoutMs, signal, trace),
    );
    return {
      tools: result.tools,
      ttlMs: normalizeCacheTtl(result.ttlMs),
      cacheScope: result.cacheScope === "public" ? "public" : "private",
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  }

  async callTool(
    tool: Tool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    trace?: McpTraceContext,
  ): Promise<McpProtocolCallResult> {
    return this.#client.callTool(
      {
        name: tool.name,
        arguments: args,
        ...(trace ? { _meta: traceMeta(trace) } : {}),
      },
      {
        ...requestOptions(this.#requestTimeoutMs, signal, trace),
        // This exact, Alfred-admitted descriptor bypasses the SDK list cache
        // and disables its HEADER_MISMATCH refetch-and-replay branch.
        toolDefinition: tool,
      },
    );
  }
}

function normalizeCacheTtl(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, value), MAX_CACHE_TTL_MS);
}

export function isMcpSessionExpiredError(err: unknown): boolean {
  return err instanceof SdkHttpError && err.status === 404;
}

export function isMcpDescriptorMismatchError(err: unknown): boolean {
  return ProtocolError.isInstance(err) && err.code === HEADER_MISMATCH_ERROR_CODE;
}

export function parseMcpNegotiatedServer(server: McpProtocolServer): McpNegotiatedServer {
  const profile = Object.values(MCP_PROTOCOL_PROFILES).find(
    (candidate) =>
      candidate.protocolEra === server.protocolEra &&
      candidate.protocolVersion === server.protocolVersion,
  );
  if (profile) {
    const facts = {
      serverName: server.serverName,
      serverVersion: server.serverVersion,
      hasTools: server.hasTools,
      toolsListChanged: server.toolsListChanged,
    };
    switch (profile.protocolEra) {
      case "pre_2026_07_28":
        return { ...facts, ...profile };
      case "post_2026_07_28":
        return { ...facts, ...profile };
    }
  }
  const version = server.protocolVersion || "unknown";
  if (!MCP_SUPPORTED_PROTOCOL_VERSION_SET.has(version)) {
    throw new Error(
      `Alfred MCP supports protocols ${MCP_SUPPORTED_PROTOCOL_VERSIONS.join(" and ")}; server negotiated ${version}`,
    );
  }
  throw new Error(
    `MCP protocol era '${server.protocolEra}' does not match negotiated version ${version}`,
  );
}

function traceMeta(trace: McpTraceContext) {
  return {
    [TRACEPARENT_META_KEY]: trace.traceparent,
    ...(trace.tracestate ? { [TRACESTATE_META_KEY]: trace.tracestate } : {}),
  };
}

function requestOptions(timeout: number, signal?: AbortSignal, trace?: McpTraceContext) {
  // `maxTotalTimeout === timeout` deliberately collapses the SDK's progress-based
  // timeout EXTENSION: a server streaming progress notifications can otherwise
  // keep a `tools/call` alive past `timeout`, blurring the delivery boundary the
  // broker's ambiguity ledger depends on. Capping total time keeps a single
  // attempt from silently outliving its window. Replay is separately disabled
  // at the transport and `callTool` boundaries above.
  return {
    timeout,
    maxTotalTimeout: timeout,
    ...(signal ? { signal } : {}),
    // Connect negotiation has no public params hook. The same controlled W3C
    // context rides HTTP headers there; ordinary MCP requests also carry it in
    // `_meta` through `traceMeta`.
    ...(trace
      ? {
          headers: {
            traceparent: trace.traceparent,
            ...(trace.tracestate ? { tracestate: trace.tracestate } : {}),
          },
        }
      : {}),
  };
}
