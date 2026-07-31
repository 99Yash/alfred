import {
  Client,
  SdkHttpError,
  StreamableHTTPClientTransport,
  type ProtocolEra,
  type StreamableHTTPClientTransportOptions,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";

export type McpProtocolCallResult = Awaited<ReturnType<Client["callTool"]>>;

export interface McpProtocolPage {
  tools: Tool[];
  nextCursor?: string;
}

export interface McpNegotiatedServer {
  protocolEra: ProtocolEra;
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
  hasTools: boolean;
  toolsListChanged: boolean;
}

/**
 * The small protocol surface Alfred consumes. Keeping this interface below
 * the execution broker prevents SDK/session details from leaking into the
 * model-facing registry and makes the trust boundary deterministic to test.
 */
export interface McpProtocolClient {
  connect(): Promise<McpNegotiatedServer>;
  close(terminateSession: boolean): Promise<void>;
  listTools(cursor: string | undefined, signal?: AbortSignal): Promise<McpProtocolPage>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpProtocolCallResult>;
  onToolsChanged(handler: () => void | Promise<void>): void;
}

export interface SdkMcpProtocolClientOptions {
  endpoint: URL;
  authProvider?: StreamableHTTPClientTransportOptions["authProvider"];
  fetch?: StreamableHTTPClientTransportOptions["fetch"];
  requestTimeoutMs: number;
}

/** Streamable HTTP implementation of Alfred's deliberately narrow MCP profile. */
export class SdkMcpProtocolClient implements McpProtocolClient {
  readonly #client: Client;
  readonly #transport: StreamableHTTPClientTransport;
  readonly #requestTimeoutMs: number;
  #toolsChangedHandler: (() => void | Promise<void>) | null = null;

  constructor(options: SdkMcpProtocolClientOptions) {
    // Empty capabilities are intentional: Alfred does not offer roots,
    // sampling, or elicitation to an untrusted remote server.
    this.#client = new Client(
      { name: "alfred", version: "1" },
      {
        capabilities: {},
        enforceStrictCapabilities: true,
        versionNegotiation: { mode: "auto" },
        inputRequired: { autoFulfill: false },
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
    this.#transport = new StreamableHTTPClientTransport(options.endpoint, {
      ...(options.authProvider ? { authProvider: options.authProvider } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.#requestTimeoutMs = options.requestTimeoutMs;
  }

  onToolsChanged(handler: () => void | Promise<void>): void {
    this.#toolsChangedHandler = handler;
  }

  async connect(): Promise<McpNegotiatedServer> {
    // Third-party variance gap, not a claim about our types: the MCP SDK's own
    // transport classes declare `sessionId?: string | undefined` / `onclose?:
    // (() => void) | undefined` while its `Transport` interface declares those
    // keys narrow, so under `exactOptionalPropertyTypes` the SDK's class does
    // not structurally satisfy the SDK's own interface. Nothing on our side can
    // reconcile the two.
    await this.#client.connect(this.#transport as Transport);
    const capabilities = this.#client.getServerCapabilities();
    const server = this.#client.getServerVersion();
    const protocolEra = this.#client.getProtocolEra();
    const protocolVersion = this.#client.getNegotiatedProtocolVersion();
    if (!protocolEra || !protocolVersion) {
      throw new Error("MCP SDK connected without a negotiated protocol era and version");
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

  async close(terminateSession: boolean): Promise<void> {
    if (
      terminateSession &&
      this.#client.getProtocolEra() === "legacy" &&
      this.#transport.sessionId
    ) {
      try {
        await this.#transport.terminateSession();
      } catch {
        // Session deletion is optional in the protocol. Closing the transport
        // must still succeed when a server returns 405 or is already gone.
      }
    }
    await this.#client.close();
  }

  async listTools(cursor: string | undefined, signal?: AbortSignal): Promise<McpProtocolPage> {
    const result = await this.#client.listTools(
      cursor ? { cursor } : undefined,
      requestOptions(this.#requestTimeoutMs, signal),
    );
    return {
      tools: result.tools,
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpProtocolCallResult> {
    return this.#client.callTool(
      { name, arguments: args },
      requestOptions(this.#requestTimeoutMs, signal),
    );
  }
}

export function isMcpSessionExpiredError(err: unknown): boolean {
  return err instanceof SdkHttpError && err.status === 404;
}

function requestOptions(timeout: number, signal?: AbortSignal) {
  // `maxTotalTimeout === timeout` deliberately collapses the SDK's progress-based
  // timeout EXTENSION: a server streaming progress notifications can otherwise
  // keep a `tools/call` alive past `timeout`, blurring the delivery boundary the
  // broker's ambiguity ledger depends on. This is NOT a retry — the SDK never
  // re-sends a `tools/call` — but capping total time keeps a single attempt from
  // silently outliving its window. See the no-replay invariant in `broker.ts`.
  return { timeout, maxTotalTimeout: timeout, ...(signal ? { signal } : {}) };
}
