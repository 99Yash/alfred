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
  type ClientOptions,
  type ProtocolEra,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import type { McpAuthorizedProtocol } from "./endpoint-authorization";
import type { JsonObject } from "@alfred/contracts";
import { McpClientError } from "./errors";
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
 * Every supported protocol era; a new SDK era fails to compile here.
 * `mirrorsParamHeaders`: the SDK copies `x-mcp-header` args into `Mcp-Param-*` headers (ADR-0095).
 */
const MCP_PROTOCOL_PROFILES = {
  legacy: {
    protocolEra: "pre_2026_07_28",
    protocolVersion: "2025-11-25",
    mirrorsParamHeaders: false,
  },
  modern: {
    protocolEra: "post_2026_07_28",
    protocolVersion: "2026-07-28",
    mirrorsParamHeaders: true,
  },
} as const satisfies Record<
  ProtocolEra,
  { protocolEra: string; protocolVersion: string; mirrorsParamHeaders: boolean }
>;

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

/** The narrow protocol surface Alfred uses, so SDK details stay below the broker. */
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
    args: JsonObject,
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
  schemaValidator: NonNullable<ClientOptions["jsonSchemaValidator"]>;
  /** Negotiate only `2025-11-25`, where `x-mcp-header` is inert (ADR-0095). */
  pinLegacyProtocol?: boolean | undefined;
}

/** Streamable HTTP implementation of Alfred's deliberately narrow MCP profile. */
export class SdkMcpProtocolClient implements McpProtocolClient {
  readonly #client: Client;
  readonly #transport: StreamableHTTPClientTransport;
  readonly #requestTimeoutMs: number;
  readonly #pinLegacyProtocol: boolean;
  #toolsChangedHandler: (() => void | Promise<void>) | null = null;
  #connectionUnhealthyHandler: ((error: Error) => void | Promise<void>) | null = null;
  #closing = false;
  #connectTrace: McpTraceContext | undefined;

  constructor(options: SdkMcpProtocolClientOptions) {
    const authProvider = options.authProvider;
    // No roots, sampling, or elicitation for an untrusted server.
    this.#client = new Client(
      { name: "alfred", version: "1" },
      {
        capabilities: MCP_CLIENT_CAPABILITIES,
        jsonSchemaValidator: options.schemaValidator,
        enforceStrictCapabilities: true,
        versionNegotiation: { mode: options.pinLegacyProtocol === true ? "legacy" : "auto" },
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
      // Transport 401 refresh and scope step-up would resend the message below the ledger.
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
    this.#pinLegacyProtocol = options.pinLegacyProtocol === true;
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

    try {
      await this.#client.connect(
        // SAFETY: under `exactOptionalPropertyTypes` the SDK's transport class does
        // not satisfy its own `Transport` interface (optional `| undefined` members).
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
      // A server that drops the pinned legacy era leaves no negotiated era. Say so in `lastError`.
      throw new McpClientError(
        "unsupported_protocol_version",
        this.#pinLegacyProtocol
          ? `The MCP server did not negotiate the pinned legacy protocol ${MCP_PROTOCOL_PROFILES.legacy.protocolVersion}`
          : "The MCP SDK connected without a negotiated protocol era and version",
      );
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
        // Session deletion is optional; a 405 or a gone server must not fail close.
      }
    }

    await this.#client.close();
  }

  async listTools(
    cursor: string | undefined,
    signal?: AbortSignal,
    trace?: McpTraceContext,
  ): Promise<McpProtocolPage> {
    // `Client.listTools` aggregates and caches every page. Alfred owns paging and bounds.
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
    args: JsonObject,
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
        // Pass the admitted descriptor: skips the SDK cache and its HEADER_MISMATCH replay.
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
  // `maxTotalTimeout === timeout` stops progress notifications from extending a call past `timeout`.
  return {
    timeout,
    maxTotalTimeout: timeout,
    ...(signal ? { signal } : {}),
    // Connect has no params hook, so trace context rides HTTP headers. Other requests use `_meta`.
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
