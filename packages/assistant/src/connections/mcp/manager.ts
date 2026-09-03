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
 * official remote MCP server (`https://api.githubcopilot.com/mcp/readonly`,
 * Streamable HTTP). Its `tools/list` shape (snake_case tools like
 * `get_pull_request` / `list_pull_requests` — the read-only catalog carries no
 * write tool, ADR-0094 — cursor pagination, per-tool input/output JSON Schema)
 * validates this broker's interface — paginated immutable catalog revisions,
 * per-descriptor hashing, and the closed `mcp.call` projection — against a real
 * catalog rather than an imagined one. It is named before merge; the OAuth /
 * connection-creation slice actually wires it.
 */

import type { ExternalToolRef } from "@alfred/contracts";
import {
  McpRawClient,
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
  type McpConnectionWithServer,
  type McpConnectionUpdate,
} from "./persistence";
import type { McpNegotiatedServer } from "./protocol";
import { McpOAuthAuthorizationRequiredError, mcpOAuthProviderForConnection } from "./oauth";
import { startMcpTraceSpan, type McpTraceContext } from "./trace";

export type McpClientFactory = (connection: McpConnectionWithServer) => McpRawClient;

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

interface CatalogRefreshState {
  dirty: boolean;
  promise: Promise<void>;
  generation: McpManagerGeneration;
}

type McpManagerCloseIntent = "shutdown" | "failure" | "disconnect";

interface McpManagerGeneration {
  readonly connectionId: string;
  phase: "starting" | "ready" | "closing";
  start: Promise<McpRawClient> | null;
  client: McpRawClient | null;
  closeDone: Promise<void> | null;
  closeIntent: McpManagerCloseIntent | null;
  closeFailure: string | null;
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
      endpoint: connection.server,
      endpointAuthorizer,
      ...(usesOAuth
        ? {
            oauthProviderFactory: (authorization) =>
              mcpOAuthProviderForConnection({
                id: connection.id,
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
  readonly #generations = new Map<string, McpManagerGeneration>();
  readonly #catalogRefreshes = new Map<string, CatalogRefreshState>();
  readonly #activeRevisionIds = new Map<string, string>();
  readonly #clientFactory: McpClientFactory;
  readonly #persistence: McpConnectionManagerPersistence;
  #shuttingDown = false;

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
    this.#assertAdmission(connectionId);
    await this.#waitForCatalogRefresh(connectionId);
    this.#assertAdmission(connectionId);
    const current = this.#generations.get(connectionId);
    if (current?.phase === "ready" && current.client) return current.client;
    if (current?.phase === "starting" && current.start) return current.start;
    if (current?.phase === "closing") throw this.#notConnected(connectionId);

    const generation: McpManagerGeneration = {
      connectionId,
      phase: "starting",
      start: null,
      client: null,
      closeDone: null,
      closeIntent: null,
      closeFailure: null,
    };
    this.#generations.set(connectionId, generation);
    const start = this.#startClient(connectionId, generation, trace);
    generation.start = start;
    return start;
  }

  async #startClient(
    connectionId: string,
    generation: McpManagerGeneration,
    trace?: McpTraceContext,
  ): Promise<McpRawClient> {
    const connection = await this.#persistence.readConnection(connectionId);
    this.#assertOpenGeneration(generation);
    if (!connection) {
      this.#generations.delete(connectionId);
      throw new McpConnectionNotFoundError(connectionId);
    }

    let client: McpRawClient;
    try {
      client = this.#clientFactory(connection);
    } catch (error) {
      if (this.#generations.get(connectionId) === generation) {
        this.#generations.delete(connectionId);
      }
      throw error;
    }
    let initializing = true;
    client.onCatalogInvalidated(() => {
      if (initializing) return;
      this.#scheduleCatalogRefresh(generation, client);
    });
    try {
      await this.#patch(connectionId, {
        status: "connecting",
        lastError: null,
      });
      this.#assertOpenGeneration(generation);
      const connectSpan = startMcpTraceSpan({
        name: "runtime.mcp.connect",
        ...(trace ? { parent: trace } : {}),
        metadata: { connectionId },
      });
      try {
        await client.connect(connectSpan.context);
        this.#assertOpenGeneration(generation);
        connectSpan.end({ status: "connected" });
      } catch (error) {
        connectSpan.end({ status: "error", level: "ERROR" });
        throw error;
      }
      for (let attempt = 1; attempt <= MAX_CATALOG_STABILIZATION_ATTEMPTS; attempt += 1) {
        await this.#refreshAndPersistStable(generation, client, undefined, connectSpan.context);
        if (client.catalog) break;
        if (attempt === MAX_CATALOG_STABILIZATION_ATTEMPTS) {
          throw new McpClientError(
            "catalog_stale",
            "The MCP catalog kept changing while the connection was starting",
          );
        }
      }
      this.#assertOpenGeneration(generation);
      generation.client = client;
      generation.phase = "ready";
      initializing = false;
      return client;
    } catch (err) {
      initializing = false;
      if (!this.#isOpenGeneration(generation)) {
        await client.close().catch(() => undefined);
        throw this.#notConnected(connectionId);
      }
      if (err instanceof McpOAuthAuthorizationRequiredError) {
        await client.close().catch(() => undefined);
        this.#assertOpenGeneration(generation);
        await this.#patch(connectionId, {
          status: "auth_required",
          lastError: "Authorization is required to connect this MCP server.",
        });
        this.#assertOpenGeneration(generation);
        this.#generations.delete(connectionId);
        throw err;
      }
      const expectedCurrentRevisionId =
        this.#activeRevisionIds.get(connectionId) ?? connection.currentCatalogRevisionId;
      this.#activeRevisionIds.delete(connectionId);
      await client.close().catch(() => undefined);
      this.#assertOpenGeneration(generation);
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
      this.#assertOpenGeneration(generation);
      this.#generations.delete(connectionId);
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
    return this.#refreshAndPersistStable(
      this.#requireReadyGeneration(connectionId, client),
      client,
      undefined,
      trace,
    );
  }

  async prepareToolCall(
    connectionId: string,
    signal?: AbortSignal,
    trace?: McpTraceContext,
  ): Promise<McpPreparedToolCall> {
    const client = await this.getReadyClient(connectionId, trace);
    return this.#prepareAndPersistStable(
      this.#requireReadyGeneration(connectionId, client),
      client,
      signal,
      trace,
    );
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
    const generation = this.#beginClosing(connectionId);
    await this.#closeGeneration(generation, "disconnect");
    return true;
  }

  /** Drop all live clients (e.g. on shutdown). Does not touch persisted rows. */
  async closeAll(): Promise<void> {
    this.#shuttingDown = true;
    const generations = [...this.#generations.values()];
    for (const generation of generations) generation.phase = "closing";
    await Promise.all(
      generations.map((generation) => this.#closeGeneration(generation, "shutdown")),
    );
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
    generation: McpManagerGeneration,
    client: McpRawClient,
    signal?: AbortSignal,
    trace?: McpTraceContext,
  ): Promise<McpCatalogSnapshot> {
    return (await this.#prepareAndPersistStable(generation, client, signal, trace)).catalog;
  }

  async #prepareAndPersistStable(
    generation: McpManagerGeneration,
    client: McpRawClient,
    signal?: AbortSignal,
    trace?: McpTraceContext,
  ): Promise<McpPreparedToolCall> {
    const { connectionId } = generation;
    this.#assertOpenGeneration(generation);
    const span = startMcpTraceSpan({
      name: "runtime.mcp.catalog_refresh",
      ...(trace ? { parent: trace } : {}),
      metadata: { connectionId },
    });
    try {
      const prepared = await this.#prepareAndPersistStableInner(
        generation,
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
    generation: McpManagerGeneration,
    client: McpRawClient,
    signal: AbortSignal | undefined,
    trace: McpTraceContext,
  ): Promise<McpPreparedToolCall> {
    const { connectionId } = generation;
    for (let attempt = 1; attempt <= MAX_CATALOG_STABILIZATION_ATTEMPTS; attempt += 1) {
      this.#assertOpenGeneration(generation);
      const durableBefore = await this.#persistence.readConnection(connectionId);
      if (!durableBefore) throw new McpConnectionNotFoundError(connectionId);
      this.#assertOpenGeneration(generation);
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
        this.#assertOpenGeneration(generation);
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
      this.#assertOpenGeneration(generation);
      if (client.catalog !== snapshot) continue;

      const activated = await this.#activateCatalog(
        connectionId,
        durableBefore.currentCatalogRevisionId,
        revisionId,
        client.negotiatedServer,
      );
      this.#assertOpenGeneration(generation);
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
      this.#assertOpenGeneration(generation);
      this.#activeRevisionIds.delete(connectionId);
    }
    throw new McpClientError(
      "catalog_stale",
      `The MCP catalog changed during ${MAX_CATALOG_STABILIZATION_ATTEMPTS} consecutive refresh attempts`,
    );
  }

  /** Coalesce list-change bursts into one durable invalidate → refresh cycle. */
  #scheduleCatalogRefresh(generation: McpManagerGeneration, client: McpRawClient): void {
    const { connectionId } = generation;
    if (!this.#isReadyGeneration(generation, client)) return;
    const existing = this.#catalogRefreshes.get(connectionId);
    if (existing) {
      existing.dirty = true;
      return;
    }
    const state: CatalogRefreshState = {
      dirty: true,
      promise: Promise.resolve(),
      generation,
    };
    state.promise = this.#drainCatalogRefreshes(generation, client, state).finally(() => {
      if (this.#catalogRefreshes.get(connectionId) === state) {
        this.#catalogRefreshes.delete(connectionId);
      }
      if (state.dirty && this.#isReadyGeneration(generation, client)) {
        this.#scheduleCatalogRefresh(generation, client);
      }
    });
    // Keep the background task observed even when no caller is waiting in
    // `getReadyClient`; awaiters still receive the original rejection.
    void state.promise.catch(() => undefined);
    this.#catalogRefreshes.set(connectionId, state);
  }

  async #drainCatalogRefreshes(
    generation: McpManagerGeneration,
    client: McpRawClient,
    state: CatalogRefreshState,
  ): Promise<void> {
    while (state.dirty && this.#isReadyGeneration(generation, client)) {
      state.dirty = false;
      await this.#refreshInvalidatedCatalog(generation, client);
    }
  }

  async #refreshInvalidatedCatalog(
    generation: McpManagerGeneration,
    client: McpRawClient,
  ): Promise<void> {
    const { connectionId } = generation;
    try {
      this.#assertOpenGeneration(generation);
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
      this.#assertOpenGeneration(generation);
      this.#activeRevisionIds.delete(connectionId);
      await this.#refreshAndPersistStable(generation, client);
    } catch (err) {
      if (!this.#isOpenGeneration(generation)) return;
      // Do not await this from inside the refresh promise: the generation closer
      // waits for that promise before it performs terminal effects. A disconnect
      // that joins meanwhile upgrades the intent and keeps the tombstone until
      // its final durable update completes.
      void this.#closeGeneration(generation, "failure", boundedMcpErrorText(err)).catch(
        () => undefined,
      );
    }
  }

  async #waitForCatalogRefresh(connectionId: string): Promise<void> {
    for (;;) {
      const state = this.#catalogRefreshes.get(connectionId);
      if (!state) return;
      await state.promise;
    }
  }

  #assertAdmission(connectionId: string): void {
    if (this.#shuttingDown || this.#generations.get(connectionId)?.phase === "closing") {
      throw this.#notConnected(connectionId);
    }
  }

  #notConnected(connectionId: string): McpClientError {
    return new McpClientError(
      "not_connected",
      `MCP connection '${connectionId}' is closing or the manager is shut down`,
    );
  }

  #isOpenGeneration(generation: McpManagerGeneration): boolean {
    return (
      !this.#shuttingDown &&
      this.#generations.get(generation.connectionId) === generation &&
      generation.phase !== "closing"
    );
  }

  #assertOpenGeneration(generation: McpManagerGeneration): void {
    if (!this.#isOpenGeneration(generation)) throw this.#notConnected(generation.connectionId);
  }

  #isReadyGeneration(generation: McpManagerGeneration, client: McpRawClient): boolean {
    return (
      this.#isOpenGeneration(generation) &&
      generation.phase === "ready" &&
      generation.client === client
    );
  }

  #requireReadyGeneration(connectionId: string, client: McpRawClient): McpManagerGeneration {
    const generation = this.#generations.get(connectionId);
    if (!generation || !this.#isReadyGeneration(generation, client)) {
      throw this.#notConnected(connectionId);
    }
    return generation;
  }

  #beginClosing(connectionId: string): McpManagerGeneration {
    const current = this.#generations.get(connectionId);
    if (current) {
      current.phase = "closing";
      return current;
    }
    const tombstone: McpManagerGeneration = {
      connectionId,
      phase: "closing",
      start: null,
      client: null,
      closeDone: null,
      closeIntent: null,
      closeFailure: null,
    };
    this.#generations.set(connectionId, tombstone);
    return tombstone;
  }

  #closeGeneration(
    generation: McpManagerGeneration,
    intent: McpManagerCloseIntent,
    failure?: string,
  ): Promise<void> {
    generation.phase = "closing";
    if (
      intent === "disconnect" ||
      (intent === "failure" && generation.closeIntent !== "disconnect") ||
      generation.closeIntent === null
    ) {
      generation.closeIntent = intent;
    }
    if (failure !== undefined) generation.closeFailure = failure;
    return (generation.closeDone ??= (async () => {
      await generation.start?.catch(() => undefined);
      for (;;) {
        const refresh = this.#catalogRefreshes.get(generation.connectionId);
        if (!refresh || refresh.generation !== generation) break;
        await refresh.promise.catch(() => undefined);
      }
      this.#activeRevisionIds.delete(generation.connectionId);
      await generation.client?.close().catch(() => undefined);
      const selectedIntent = generation.closeIntent;
      if (selectedIntent === "disconnect") {
        await this.#patch(generation.connectionId, { status: "disconnected" });
      } else if (selectedIntent === "failure") {
        await this.#persistence.compareAndSetCatalogRevision({
          connectionId: generation.connectionId,
          expectedCurrentRevisionId: null,
          nextRevisionId: null,
          patch: {
            status: "failed",
            lastError: generation.closeFailure ?? "The MCP catalog refresh failed",
          },
        });
        if (generation.closeIntent === "disconnect") {
          await this.#patch(generation.connectionId, { status: "disconnected" });
        }
      }
      if (this.#generations.get(generation.connectionId) === generation) {
        this.#generations.delete(generation.connectionId);
      }
    })());
  }
}
