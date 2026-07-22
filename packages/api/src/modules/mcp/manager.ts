/**
 * MCP connection manager (PRD #540) — the layer between durable connection FACTS
 * (`mcp_connections`, via `persistence.ts`) and live, in-memory `McpRawClient`
 * instances. Connection rows are durable; the SDK client behind them is not, so
 * the manager re-hydrates a client on demand, drives connect + catalog refresh,
 * and folds the refreshed catalog back into an immutable revision through
 * `publishCatalogRevision`. The execution broker asks this manager for a ready
 * client; it never constructs one itself.
 *
 * Two injection seams keep the whole path testable offline (no network/OAuth):
 *  - `clientFactory` builds the `McpRawClient` for a connection row. Tests pass a
 *    factory that wires a real client to a FAKE `McpProtocolClient` (via the raw
 *    client's own `protocolFactory`), exercising real validation/bounding code
 *    without a socket.
 *  - `endpointAuthorization` is handed to the DEFAULT factory only. It is a
 *    placeholder here: v1 enforces https + origin-pinning but the full SSRF /
 *    DNS-rebinding guard is a later slice, and no connection-creation route wires
 *    an untrusted endpoint to it yet.
 *
 * PRD guardrail — first real server: the intended first connection is GitHub's
 * official remote MCP server (`https://api.githubcopilot.com/mcp/`, Streamable
 * HTTP). Its `tools/list` shape (snake_case tools like `create_issue` /
 * `list_pull_requests`, cursor pagination, per-tool input/output JSON Schema)
 * validates this broker's interface — paginated immutable catalog revisions,
 * per-descriptor hashing, and the closed `mcp.call` projection — against a real
 * catalog rather than an imagined one. It is named before merge; the OAuth /
 * connection-creation slice actually wires it.
 */

import { toMessage } from "@alfred/contracts";
import type { McpConnection } from "@alfred/db/schemas";
import {
  McpRawClient,
  type ExternalToolRef,
  type McpCallEnvelope,
  type McpCatalogSnapshot,
  type McpEndpointAuthorization,
} from "./client";
import { computeDescriptorHashes } from "./hash";
import {
  publishCatalogRevision,
  readConnection,
  updateConnection,
  type McpConnectionUpdate,
} from "./persistence";
import type { McpNegotiatedServer } from "./protocol";

export type McpClientFactory = (connection: McpConnection) => McpRawClient;

export interface McpConnectionManagerOptions {
  clientFactory?: McpClientFactory;
  /** Handed to the default `clientFactory` only. Ignored when one is injected. */
  endpointAuthorization?: McpEndpointAuthorization;
}

export class McpConnectionNotFoundError extends Error {
  constructor(connectionId: string) {
    super(`MCP connection '${connectionId}' does not exist`);
    this.name = "McpConnectionNotFoundError";
  }
}

/**
 * Placeholder endpoint authorization for the default factory. Enforces https and
 * pins to the exact origin; it does NOT yet block private/loopback IPs or DNS
 * rebinding (the SSRF slice owns that). Only reached by the production default
 * factory, never by tests (which inject their own client).
 */
class HttpsOriginPinnedAuthorization implements McpEndpointAuthorization {
  async authorize(endpoint: URL): Promise<URL> {
    if (endpoint.protocol !== "https:") {
      throw new Error(`MCP endpoint must be https: ${endpoint.origin}`);
    }
    return new URL(endpoint.href);
  }
}

export class McpConnectionManager {
  readonly #clients = new Map<string, McpRawClient>();
  readonly #clientFactory: McpClientFactory;

  constructor(options: McpConnectionManagerOptions = {}) {
    const authorization =
      options.endpointAuthorization ?? new HttpsOriginPinnedAuthorization();
    this.#clientFactory =
      options.clientFactory ??
      ((connection) =>
        new McpRawClient({
          connectionId: connection.id,
          endpoint: new URL(connection.endpointUrl),
          endpointAuthorization: authorization,
        }));
  }

  /**
   * Return a connected client whose catalog has been refreshed and published at
   * least once. Cached per connection id for the process lifetime; a first call
   * connects, refreshes, and persists the revision, updating connection status
   * along the way. On any failure the client is dropped and the connection is
   * marked `failed` with a bounded error string.
   */
  async getReadyClient(connectionId: string): Promise<McpRawClient> {
    const cached = this.#clients.get(connectionId);
    if (cached) return cached;

    const connection = await readConnection(connectionId);
    if (!connection) throw new McpConnectionNotFoundError(connectionId);

    const client = this.#clientFactory(connection);
    try {
      await this.#patch(connectionId, { status: "connecting", lastError: null });
      await client.connect();
      const snapshot = await client.refreshCatalog();
      await this.#persistCatalog(connectionId, snapshot, client.negotiatedServer);
      this.#clients.set(connectionId, client);
      return client;
    } catch (err) {
      await client.close().catch(() => undefined);
      await this.#patch(connectionId, { status: "failed", lastError: toMessage(err) });
      throw err;
    }
  }

  /**
   * Refresh the catalog of an already-ready connection and publish the resulting
   * revision. Idempotent: an unchanged catalog re-publishes to the same revision
   * and only touches the connection's `lastConnectedAt`.
   */
  async refreshCatalog(connectionId: string): Promise<McpCatalogSnapshot> {
    const client = await this.getReadyClient(connectionId);
    const snapshot = await client.refreshCatalog();
    await this.#persistCatalog(connectionId, snapshot, client.negotiatedServer);
    return snapshot;
  }

  /** Route a validated call to a ready client. The broker owns the durable ledger around this. */
  async callTool(
    ref: ExternalToolRef,
    args: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<McpCallEnvelope> {
    const client = await this.getReadyClient(ref.connectionId);
    return client.callTool(ref, args, options);
  }

  /** Close and forget a connection's live client; mark the row disconnected. */
  async disconnect(connectionId: string): Promise<void> {
    const client = this.#clients.get(connectionId);
    this.#clients.delete(connectionId);
    if (client) await client.close().catch(() => undefined);
    await this.#patch(connectionId, { status: "disconnected" });
  }

  /** Drop all live clients (e.g. on shutdown). Does not touch persisted rows. */
  async closeAll(): Promise<void> {
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  }

  async #persistCatalog(
    connectionId: string,
    snapshot: McpCatalogSnapshot,
    negotiated: McpNegotiatedServer | null,
  ): Promise<void> {
    await publishCatalogRevision({
      connectionId,
      revisionHash: snapshot.revision,
      descriptors: snapshot.tools,
      descriptorHashes: computeDescriptorHashes(snapshot.tools),
      toolCount: snapshot.tools.length,
    });
    await this.#patch(connectionId, {
      status: "ready",
      lastConnectedAt: new Date(),
      lastError: null,
      ...(negotiated
        ? {
            negotiatedProtocolVersion: negotiated.protocolVersion,
            serverIdentity: {
              protocolVersion: negotiated.protocolVersion,
              serverName: negotiated.serverName,
              serverVersion: negotiated.serverVersion,
              hasTools: negotiated.hasTools,
              toolsListChanged: negotiated.toolsListChanged,
            },
          }
        : {}),
    });
  }

  async #patch(connectionId: string, patch: McpConnectionUpdate): Promise<void> {
    await updateConnection(connectionId, patch);
  }
}
