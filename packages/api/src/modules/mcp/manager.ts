/**
 * MCP connection manager (PRD #540) — the layer between durable connection FACTS
 * (`mcp_connections`, via `persistence.ts`) and live, in-memory `McpRawClient`
 * instances. Connection rows are durable; the SDK client behind them is not, so
 * the manager re-hydrates a client on demand, drives connect + catalog refresh,
 * inserts the refreshed immutable revision, then promotes it only while that
 * in-memory generation remains current. The execution broker asks this manager
 * for a ready client; it never constructs one itself.
 *
 * Injection seams keep the whole path testable offline (no network/OAuth/DB):
 *  - `clientFactory` builds the `McpRawClient` for a connection row. Tests pass a
 *    factory that wires a real client to a FAKE `McpProtocolClient` (via the raw
 *    client's own `protocolFactory`), exercising real validation/bounding code
 *    without a socket.
 *  - `endpointAuthorization` is handed to the DEFAULT factory only. It is a
 *    placeholder here: v1 enforces https + origin-pinning but the full SSRF /
 *    DNS-rebinding guard is a later slice, and no connection-creation route wires
 *    an untrusted endpoint to it yet.
 *  - `persistence` lets lifecycle tests drive publication races without requiring
 *    Postgres; production always receives the module-owned default adapter.
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

import type { McpConnection } from "@alfred/db/schemas";
import {
  McpRawClient,
  type ExternalToolRef,
  type McpCallEnvelope,
  type McpCatalogSnapshot,
  type McpEndpointAuthorization,
  type McpPreparedToolCall,
} from "./client";
import { boundedMcpErrorText, McpClientError } from "./errors";
import { computeDescriptorHashes } from "./hash";
import {
  insertCatalogRevision,
  readConnection,
  updateConnection,
  type McpConnectionUpdate,
} from "./persistence";
import type { McpNegotiatedServer } from "./protocol";

export type McpClientFactory = (connection: McpConnection) => McpRawClient;

export interface McpConnectionManagerPersistence {
  readConnection: typeof readConnection;
  updateConnection: typeof updateConnection;
  insertCatalogRevision: typeof insertCatalogRevision;
}

export interface McpConnectionManagerOptions {
  clientFactory?: McpClientFactory;
  /** Handed to the default `clientFactory` only. Ignored when one is injected. */
  endpointAuthorization?: McpEndpointAuthorization;
  persistence?: McpConnectionManagerPersistence;
}

const DEFAULT_PERSISTENCE: McpConnectionManagerPersistence = {
  readConnection,
  updateConnection,
  insertCatalogRevision,
};

const MAX_CATALOG_STABILIZATION_ATTEMPTS = 3;

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

/**
 * The production factory: a live client per connection row, authorized by
 * `authorization`. Note what it does NOT pass — `authProvider`. Every connection
 * built here is therefore UNAUTHENTICATED; wiring the Alfred→server credential is
 * the OAuth slice's job (see `mcp_connections.credentialId`, still storeless).
 */
function liveClientFactory(authorization: McpEndpointAuthorization): McpClientFactory {
  return (connection) =>
    new McpRawClient({
      connectionId: connection.id,
      endpoint: new URL(connection.endpointUrl),
      endpointAuthorization: authorization,
    });
}

export class McpConnectionManager {
  readonly #clients = new Map<string, McpRawClient>();
  readonly #catalogRefreshes = new Map<string, Promise<void>>();
  readonly #clientFactory: McpClientFactory;
  readonly #persistence: McpConnectionManagerPersistence;

  constructor(options: McpConnectionManagerOptions = {}) {
    this.#clientFactory =
      options.clientFactory ??
      liveClientFactory(options.endpointAuthorization ?? new HttpsOriginPinnedAuthorization());
    this.#persistence = options.persistence ?? DEFAULT_PERSISTENCE;
  }

  /**
   * Return a connected client whose catalog has been refreshed and published at
   * least once. Cached per connection id for the process lifetime; a first call
   * connects, refreshes, and persists the revision, updating connection status
   * along the way. On any failure the client is dropped and the connection is
   * marked `failed` with a bounded error string.
   */
  async getReadyClient(connectionId: string): Promise<McpRawClient> {
    await this.#waitForCatalogRefresh(connectionId);
    const cached = this.#clients.get(connectionId);
    if (cached) return cached;

    const connection = await this.#persistence.readConnection(connectionId);
    if (!connection) throw new McpConnectionNotFoundError(connectionId);

    const client = this.#clientFactory(connection);
    try {
      await this.#patch(connectionId, {
        status: "connecting",
        currentCatalogRevisionId: null,
        lastError: null,
      });
      await client.connect();
      await this.#refreshAndPersistStable(connectionId, client);
      this.#clients.set(connectionId, client);
      client.onCatalogInvalidated(() => this.#scheduleCatalogRefresh(connectionId, client));
      return client;
    } catch (err) {
      await client.close().catch(() => undefined);
      // `boundedMcpErrorText`, not `toMessage`: the SDK inlines the whole upstream
      // response body into its thrown message, and this lands in a durable column.
      await this.#patch(connectionId, {
        status: "failed",
        currentCatalogRevisionId: null,
        lastError: boundedMcpErrorText(err),
      });
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
    return this.#refreshAndPersistStable(connectionId, client);
  }

  async prepareToolCall(connectionId: string, signal?: AbortSignal): Promise<McpPreparedToolCall> {
    const client = await this.getReadyClient(connectionId);
    return this.#prepareAndPersistStable(connectionId, client, signal);
  }

  /** Route a validated call to a ready client. The broker owns the durable ledger around this. */
  async callTool(
    ref: ExternalToolRef,
    args: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<McpCallEnvelope> {
    const prepared = await this.prepareToolCall(ref.connectionId, options.signal);
    return prepared.call(ref, args, options);
  }

  /** Close and forget a connection's live client; mark the row disconnected. */
  async disconnect(connectionId: string): Promise<void> {
    await this.#waitForCatalogRefresh(connectionId);
    const client = this.#clients.get(connectionId);
    this.#clients.delete(connectionId);
    if (client) await client.close().catch(() => undefined);
    await this.#patch(connectionId, { status: "disconnected" });
  }

  /** Drop all live clients (e.g. on shutdown). Does not touch persisted rows. */
  async closeAll(): Promise<void> {
    while (this.#catalogRefreshes.size > 0) {
      await Promise.all(this.#catalogRefreshes.values());
    }
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  }

  async #insertCatalog(connectionId: string, snapshot: McpCatalogSnapshot): Promise<string> {
    const revision = await this.#persistence.insertCatalogRevision({
      connectionId,
      revisionHash: snapshot.revision,
      descriptors: snapshot.tools,
      descriptorHashes: computeDescriptorHashes(snapshot.tools),
      toolCount: snapshot.tools.length,
    });
    return revision.id;
  }

  async #activateCatalog(
    connectionId: string,
    revisionId: string,
    negotiated: McpNegotiatedServer | null,
  ): Promise<void> {
    await this.#patch(connectionId, {
      status: "ready",
      currentCatalogRevisionId: revisionId,
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
    await this.#persistence.updateConnection(connectionId, patch);
  }

  /**
   * Publish only a snapshot that remained live through the DB transaction. A
   * list-change event during publication clears the raw catalog; loop once more
   * so the durable pointer cannot become authoritative for an invalidated view.
   */
  async #refreshAndPersistStable(
    connectionId: string,
    client: McpRawClient,
  ): Promise<McpCatalogSnapshot> {
    return (await this.#prepareAndPersistStable(connectionId, client)).catalog;
  }

  async #prepareAndPersistStable(
    connectionId: string,
    client: McpRawClient,
    signal?: AbortSignal,
  ): Promise<McpPreparedToolCall> {
    for (let attempt = 1; attempt <= MAX_CATALOG_STABILIZATION_ATTEMPTS; attempt += 1) {
      const priorCatalog = client.catalog;
      let prepared: McpPreparedToolCall;
      try {
        prepared = await client.prepareToolCall(signal);
      } catch (err) {
        if (
          err instanceof McpClientError &&
          err.code === "catalog_stale" &&
          attempt < MAX_CATALOG_STABILIZATION_ATTEMPTS
        ) {
          continue;
        }
        throw err;
      }
      const snapshot = prepared.catalog;
      if (snapshot === priorCatalog) return prepared;

      const revisionId = await this.#insertCatalog(connectionId, snapshot);
      if (client.catalog !== snapshot) continue;

      await this.#activateCatalog(connectionId, revisionId, client.negotiatedServer);
      if (client.catalog === snapshot) return prepared;

      // An event won the race with pointer activation. Remove the stale door
      // before the bounded coordinator tries the replacement generation.
      await this.#patch(connectionId, {
        status: "stale",
        currentCatalogRevisionId: null,
      });
    }
    throw new McpClientError(
      "catalog_stale",
      `The MCP catalog changed during ${MAX_CATALOG_STABILIZATION_ATTEMPTS} consecutive refresh attempts`,
    );
  }

  /** Coalesce list-change bursts into one durable invalidate → refresh cycle. */
  #scheduleCatalogRefresh(connectionId: string, client: McpRawClient): void {
    if (this.#clients.get(connectionId) !== client) return;
    if (this.#catalogRefreshes.has(connectionId)) return;
    const refresh = this.#refreshInvalidatedCatalog(connectionId, client).finally(() => {
      if (this.#catalogRefreshes.get(connectionId) === refresh) {
        this.#catalogRefreshes.delete(connectionId);
      }
    });
    // Keep the background task observed even when no caller is waiting in
    // `getReadyClient`; awaiters still receive the original rejection.
    void refresh.catch(() => undefined);
    this.#catalogRefreshes.set(connectionId, refresh);
  }

  async #refreshInvalidatedCatalog(connectionId: string, client: McpRawClient): Promise<void> {
    try {
      // Fail closed while the replacement is fetched: local catalog readers
      // must not keep serving the revision the server just invalidated.
      await this.#patch(connectionId, {
        status: "stale",
        currentCatalogRevisionId: null,
        lastError: null,
      });
      await this.#refreshAndPersistStable(connectionId, client);
    } catch (err) {
      if (this.#clients.get(connectionId) === client) {
        this.#clients.delete(connectionId);
      }
      await client.close().catch(() => undefined);
      await this.#patch(connectionId, {
        status: "failed",
        currentCatalogRevisionId: null,
        lastError: boundedMcpErrorText(err),
      });
    }
  }

  async #waitForCatalogRefresh(connectionId: string): Promise<void> {
    for (;;) {
      const refresh = this.#catalogRefreshes.get(connectionId);
      if (!refresh) return;
      await refresh;
    }
  }
}
