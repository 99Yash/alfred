import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPError,
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

export type McpProtocolCallResult = Awaited<ReturnType<Client["callTool"]>>;

export interface McpProtocolPage {
  tools: Tool[];
  nextCursor?: string;
}

export interface McpNegotiatedServer {
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
  hasTools: boolean;
  toolsListChanged: boolean;
}

/**
 * The small protocol surface Alfred v1 consumes. Keeping this interface below
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

  constructor(options: SdkMcpProtocolClientOptions) {
    // Empty capabilities are intentional: Alfred v1 does not offer roots,
    // sampling, or elicitation to an untrusted remote server.
    this.#client = new Client(
      { name: "alfred", version: "1" },
      { capabilities: {}, enforceStrictCapabilities: true },
    );
    this.#transport = new StreamableHTTPClientTransport(options.endpoint, {
      ...(options.authProvider ? { authProvider: options.authProvider } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.#requestTimeoutMs = options.requestTimeoutMs;
  }

  onToolsChanged(handler: () => void | Promise<void>): void {
    this.#client.setNotificationHandler(ToolListChangedNotificationSchema, handler);
  }

  async connect(): Promise<McpNegotiatedServer> {
    await this.#client.connect(this.#transport);
    const capabilities = this.#client.getServerCapabilities();
    const server = this.#client.getServerVersion();
    return {
      protocolVersion: this.#transport.protocolVersion ?? "",
      serverName: server?.name ?? "unknown",
      serverVersion: server?.version ?? "unknown",
      hasTools: capabilities?.tools !== undefined,
      toolsListChanged: capabilities?.tools?.listChanged === true,
    };
  }

  async close(terminateSession: boolean): Promise<void> {
    if (terminateSession && this.#transport.sessionId) {
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
      undefined,
      requestOptions(this.#requestTimeoutMs, signal),
    );
  }
}

export function isMcpSessionExpiredError(err: unknown): boolean {
  return err instanceof StreamableHTTPError && err.code === 404;
}

function requestOptions(timeout: number, signal?: AbortSignal) {
  return { timeout, maxTotalTimeout: timeout, ...(signal ? { signal } : {}) };
}
