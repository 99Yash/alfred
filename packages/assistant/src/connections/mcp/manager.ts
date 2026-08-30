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
 *  - The default factory always uses the hosted endpoint authorizer. Tests that
 *    need a local transport inject the complete `clientFactory` seam.
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
  type McpPreparedToolCall,
} from "./client";
import { HostedMcpEndpointAuthorizer } from "./endpoint-authorization";
import { boundedMcpErrorText, McpClientError } from "./errors";
import { computeDescriptorHashes } from "./hash";
import {
  compareAndSetCatalogRevision,
  insertCatalogRevision,
  readConnection,
  readOwnedConnection,
  updateConnection,
  type McpConnectionUpdate,
} from "./persistence";
import type { McpNegotiatedServer } from "./protocol";
import { McpOAuthAuthorizationRequiredError, mcpOAuthProviderForConnection } from "./oauth";
import { startMcpTraceSpan, type McpTraceContext } from "./trace";

export type McpClientFactory = (connection: McpConnection) => McpRawClient;

export interface McpConnectionManagerPersistence {
  readConnection: typeof readConnection;
  readOwnedConnection: typeof readOwnedConnection;
  updateConnection: typeof updateConnection;
  insertCatalogRevision: typeof insertCatalogRevision;
  compareAndSetCatalogRevision: typeof compareAndSetCatalogRevision;
}

export interface McpConnectionManagerOptions {
  clientFactory?: McpClientFactory;
  persistence?: McpConnectionManagerPersistence;
}

const DEFAULT_PERSISTENCE: McpConnectionManagerPersistence = {
  readConnection,
  readOwnedConnection,
  updateConnection,
  insertCatalogRevision,
  compareAndSetCatalogRevision,
};

const MAX_CATALOG_STABILIZATION_ATTEMPTS = 3;
export const MCP_OAUTH_PENDING_ISSUER = "oauth:pending";

interface CatalogRefreshState {
  dirty: boolean;
  promise: Promise<void>;
}

export class McpConnectionNotFoundError extends Error {
  constructor(connectionId: string) {
    super(`MCP connection '${connectionId}' does not exist`);
    this.name = "McpConnectionNotFoundError";
  }
}

/**
 * The production factory: a live client per connection row, authorized by
 * `authorization`. OAuth discovery runs before transport connect. The transport
 * itself receives only a token reader, so it cannot refresh and replay an
 * in-flight call.
 */
function liveClientFactory(): McpClientFactory {
  const endpointAuthorizer = new HostedMcpEndpointAuthorizer();
  return (connection) => {
    const usesOAuth = connection.credentialId !== null || connection.authServerIdentity !== null;
    return new McpRawClient({
      connectionId: connection.id,
      endpoint: connection.endpointUrl,
      expectedOrigin: connection.endpointOrigin,
      endpointAuthorizer,
      ...(usesOAuth
        ? {
            oauthProviderFactory: (authorization) =>
              mcpOAuthProviderForConnection({
                connectionId: connection.id,
                userId: connection.userId,
                authorization,
              }),
            onAuthorizationRequired: async () => {
              await updateConnection(connection.id, {
                status: "auth_required",
                lastError: "Reconnect this MCP server to continue.",
              });
            },
            onInsufficientScope: async (requiredScopes: string[]) => {
              const suffix =
                requiredScopes.length > 0 ? ` Required: ${requiredScopes.join(", ")}.` : "";
              await updateConnection(connection.id, {
                status: "auth_required",
                requiredScopes,
                lastError: `Reconnect this MCP server to grant additional permissions.${suffix}`,
              });
            },
          }
        : {}),
    });
  };
}

export class McpConnectionManager {
  readonly #clients = new Map<string, McpRawClient>();
  readonly #clientStarts = new Map<string, Promise<McpRawClient>>();
  readonly #catalogRefreshes = new Map<string, CatalogRefreshState>();
  readonly #activeRevisionIds = new Map<string, string>();
  readonly #closingConnections = new Set<string>();
  readonly #clientFactory: McpClientFactory;
  readonly #persistence: McpConnectionManagerPersistence;

  constructor(options: McpConnectionManagerOptions = {}) {
    this.#clientFactory = options.clientFactory ?? liveClientFactory();
    this.#persistence = options.persistence ?? DEFAULT_PERSISTENCE;
  }

  /**
   * Return a connected client whose catalog has been refreshed and published at
   * least once. Cached per connection id for the process lifetime; a first call
   * connects, refreshes, and persists the revision, updating connection status
   * along the way. On any failure the client is dropped and the connection is
   * marked `failed` with a bounded error string.
   */
  async getReadyClient(connectionId: string, trace?: McpTraceContext): Promise<McpRawClient> {
    await this.#waitForCatalogRefresh(connectionId);
    const cached = this.#clients.get(connectionId);
    if (cached) return cached;

    const existingStart = this.#clientStarts.get(connectionId);
    if (existingStart) return existingStart;

    const start = this.#startClient(connectionId, trace).finally(() => {
      if (this.#clientStarts.get(connectionId) === start) {
        this.#clientStarts.delete(connectionId);
      }
    });
    this.#clientStarts.set(connectionId, start);
    return start;
  }

  async #startClient(connectionId: string, trace?: McpTraceContext): Promise<McpRawClient> {
    const connection = await this.#persistence.readConnection(connectionId);
    if (!connection) throw new McpConnectionNotFoundError(connectionId);

    const client = this.#clientFactory(connection);
    let initializing = true;
    client.onCatalogInvalidated(() => {
      if (initializing) return;
      this.#scheduleCatalogRefresh(connectionId, client);
    });
    try {
      await this.#patch(connectionId, {
        status: "connecting",
        lastError: null,
      });
      const connectSpan = startMcpTraceSpan({
        name: "runtime.mcp.connect",
        ...(trace ? { parent: trace } : {}),
        metadata: { connectionId },
      });
      try {
        await client.connect(connectSpan.context);
        connectSpan.end({ status: "connected" });
      } catch (error) {
        connectSpan.end({ status: "error", level: "ERROR" });
        throw error;
      }
      for (let attempt = 1; attempt <= MAX_CATALOG_STABILIZATION_ATTEMPTS; attempt += 1) {
        await this.#refreshAndPersistStable(connectionId, client, undefined, connectSpan.context);
        if (client.catalog) break;
        if (attempt === MAX_CATALOG_STABILIZATION_ATTEMPTS) {
          throw new McpClientError(
            "catalog_stale",
            "The MCP catalog kept changing while the connection was starting",
          );
        }
      }
      this.#clients.set(connectionId, client);
      initializing = false;
      return client;
    } catch (err) {
      initializing = false;
      if (err instanceof McpOAuthAuthorizationRequiredError) {
        await client.close().catch(() => undefined);
        await this.#patch(connectionId, {
          status: "auth_required",
          lastError: "Authorization is required to connect this MCP server.",
        });
        throw err;
      }
      const expectedCurrentRevisionId =
        this.#activeRevisionIds.get(connectionId) ?? connection.currentCatalogRevisionId;
      this.#activeRevisionIds.delete(connectionId);
      await client.close().catch(() => undefined);
      // `boundedMcpErrorText`, not `toMessage`: the SDK inlines the whole upstream
      // response body into its thrown message, and this lands in a durable column.
      await this.#persistence.compareAndSetCatalogRevision({
        connectionId,
        expectedCurrentRevisionId,
        nextRevisionId: null,
        patch: {
          status: "failed",
          lastError: boundedMcpErrorText(err),
        },
      });
      throw err;
    }
  }

  /**
   * Refresh the catalog of an already-ready connection and publish the resulting
   * revision. Idempotent: an unchanged catalog re-publishes to the same revision
   * and only touches the connection's `lastConnectedAt`.
   */
  async refreshCatalog(connectionId: string, trace?: McpTraceContext): Promise<McpCatalogSnapshot> {
    const client = await this.getReadyClient(connectionId, trace);
    return this.#refreshAndPersistStable(connectionId, client, undefined, trace);
  }

  async prepareToolCall(
    connectionId: string,
    signal?: AbortSignal,
    trace?: McpTraceContext,
  ): Promise<McpPreparedToolCall> {
    const client = await this.getReadyClient(connectionId, trace);
    return this.#prepareAndPersistStable(connectionId, client, signal, trace);
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
  async disconnect(connectionId: string, userId: string): Promise<boolean> {
    const owned = await this.#persistence.readOwnedConnection(connectionId, userId);
    if (!owned) return false;
    this.#closingConnections.add(connectionId);
    try {
      await this.#clientStarts.get(connectionId)?.catch(() => undefined);
      await this.#waitForCatalogRefresh(connectionId);
      const client = this.#clients.get(connectionId);
      this.#clients.delete(connectionId);
      this.#activeRevisionIds.delete(connectionId);
      if (client) await client.close().catch(() => undefined);
      await this.#patch(connectionId, { status: "disconnected" });
      return true;
    } finally {
      this.#closingConnections.delete(connectionId);
    }
  }

  /** Drop all live clients (e.g. on shutdown). Does not touch persisted rows. */
  async closeAll(): Promise<void> {
    for (const connectionId of new Set([...this.#clientStarts.keys(), ...this.#clients.keys()])) {
      this.#closingConnections.add(connectionId);
    }
    await Promise.all(
      [...this.#clientStarts.values()].map((start) => start.catch(() => undefined)),
    );
    while (this.#catalogRefreshes.size > 0) {
      await Promise.all([...this.#catalogRefreshes.values()].map((state) => state.promise));
    }
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    this.#activeRevisionIds.clear();
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
    expectedCurrentRevisionId: string | null,
    revisionId: string,
    negotiated: McpNegotiatedServer | null,
  ): Promise<boolean> {
    const activated = await this.#persistence.compareAndSetCatalogRevision({
      connectionId,
      expectedCurrentRevisionId,
      nextRevisionId: revisionId,
      patch: {
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
      },
    });
    return activated !== undefined;
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
    signal?: AbortSignal,
    trace?: McpTraceContext,
  ): Promise<McpCatalogSnapshot> {
    return (await this.#prepareAndPersistStable(connectionId, client, signal, trace)).catalog;
  }

  async #prepareAndPersistStable(
    connectionId: string,
    client: McpRawClient,
    signal?: AbortSignal,
    trace?: McpTraceContext,
  ): Promise<McpPreparedToolCall> {
    const span = startMcpTraceSpan({
      name: "runtime.mcp.catalog_refresh",
      ...(trace ? { parent: trace } : {}),
      metadata: { connectionId },
    });
    try {
      const prepared = await this.#prepareAndPersistStableInner(
        connectionId,
        client,
        signal,
        span.context,
      );
      span.end({
        status: "ready",
        metadata: {
          catalogRevision: prepared.catalog.revision,
          toolCount: prepared.catalog.tools.length,
        },
      });
      return prepared;
    } catch (error) {
      span.end({ status: "error", level: "ERROR" });
      throw error;
    }
  }

  async #prepareAndPersistStableInner(
    connectionId: string,
    client: McpRawClient,
    signal: AbortSignal | undefined,
    trace: McpTraceContext,
  ): Promise<McpPreparedToolCall> {
    for (let attempt = 1; attempt <= MAX_CATALOG_STABILIZATION_ATTEMPTS; attempt += 1) {
      const durableBefore = await this.#persistence.readConnection(connectionId);
      if (!durableBefore) throw new McpConnectionNotFoundError(connectionId);
      let priorCatalog = client.catalog;
      const activeRevisionId = this.#activeRevisionIds.get(connectionId);
      if (
        priorCatalog &&
        (activeRevisionId === undefined ||
          durableBefore.currentCatalogRevisionId !== activeRevisionId)
      ) {
        client.invalidateCatalogAuthority();
        priorCatalog = null;
      }
      let prepared: McpPreparedToolCall;
      try {
        prepared = await client.prepareToolCall(signal, trace);
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
      if (
        snapshot === priorCatalog &&
        activeRevisionId !== undefined &&
        durableBefore.currentCatalogRevisionId === activeRevisionId
      ) {
        return prepared;
      }

      const revisionId = await this.#insertCatalog(connectionId, snapshot);
      if (client.catalog !== snapshot) continue;

      const activated = await this.#activateCatalog(
        connectionId,
        durableBefore.currentCatalogRevisionId,
        revisionId,
        client.negotiatedServer,
      );
      if (!activated) {
        client.invalidateCatalogAuthority();
        continue;
      }
      this.#activeRevisionIds.set(connectionId, revisionId);
      if (client.catalog === snapshot) return prepared;

      // An event won the race with pointer activation. Remove the stale door
      // before the bounded coordinator tries the replacement generation.
      await this.#persistence.compareAndSetCatalogRevision({
        connectionId,
        expectedCurrentRevisionId: revisionId,
        nextRevisionId: null,
        patch: { status: "stale" },
      });
      this.#activeRevisionIds.delete(connectionId);
    }
    throw new McpClientError(
      "catalog_stale",
      `The MCP catalog changed during ${MAX_CATALOG_STABILIZATION_ATTEMPTS} consecutive refresh attempts`,
    );
  }

  /** Coalesce list-change bursts into one durable invalidate → refresh cycle. */
  #scheduleCatalogRefresh(connectionId: string, client: McpRawClient): void {
    if (this.#clients.get(connectionId) !== client) return;
    if (this.#closingConnections.has(connectionId)) return;
    const existing = this.#catalogRefreshes.get(connectionId);
    if (existing) {
      existing.dirty = true;
      return;
    }
    const state: CatalogRefreshState = {
      dirty: true,
      promise: Promise.resolve(),
    };
    state.promise = this.#drainCatalogRefreshes(connectionId, client, state).finally(() => {
      if (this.#catalogRefreshes.get(connectionId) === state) {
        this.#catalogRefreshes.delete(connectionId);
      }
      if (
        state.dirty &&
        this.#clients.get(connectionId) === client &&
        !this.#closingConnections.has(connectionId)
      ) {
        this.#scheduleCatalogRefresh(connectionId, client);
      }
    });
    // Keep the background task observed even when no caller is waiting in
    // `getReadyClient`; awaiters still receive the original rejection.
    void state.promise.catch(() => undefined);
    this.#catalogRefreshes.set(connectionId, state);
  }

  async #drainCatalogRefreshes(
    connectionId: string,
    client: McpRawClient,
    state: CatalogRefreshState,
  ): Promise<void> {
    while (
      state.dirty &&
      this.#clients.get(connectionId) === client &&
      !this.#closingConnections.has(connectionId)
    ) {
      state.dirty = false;
      await this.#refreshInvalidatedCatalog(connectionId, client);
    }
  }

  async #refreshInvalidatedCatalog(connectionId: string, client: McpRawClient): Promise<void> {
    try {
      // Fail closed while the replacement is fetched: local catalog readers
      // must not keep serving the revision the server just invalidated.
      const expectedCurrentRevisionId = this.#activeRevisionIds.get(connectionId) ?? null;
      await this.#persistence.compareAndSetCatalogRevision({
        connectionId,
        expectedCurrentRevisionId,
        nextRevisionId: null,
        patch: {
          status: "stale",
          lastError: null,
        },
      });
      this.#activeRevisionIds.delete(connectionId);
      await this.#refreshAndPersistStable(connectionId, client);
    } catch (err) {
      if (this.#clients.get(connectionId) === client) {
        this.#clients.delete(connectionId);
      }
      await client.close().catch(() => undefined);
      await this.#persistence.compareAndSetCatalogRevision({
        connectionId,
        expectedCurrentRevisionId: null,
        nextRevisionId: null,
        patch: {
          status: "failed",
          lastError: boundedMcpErrorText(err),
        },
      });
    }
  }

  async #waitForCatalogRefresh(connectionId: string): Promise<void> {
    for (;;) {
      const state = this.#catalogRefreshes.get(connectionId);
      if (!state) return;
      await state.promise;
    }
  }
}
