/**
 * Builds live `McpRawClient`s from `mcp_connections` rows on demand: connect,
 * refresh the catalog, insert the revision, and promote it only while that generation is live.
 * Tests inject `clientFactory` and `persistence` to run offline.
 */

import type { ExternalToolRef } from "@alfred/contracts";
import {
  McpRawClient,
  type McpCallEnvelope,
  type McpCatalogSnapshot,
  type McpClientAuth,
  type McpPreparedToolCall,
} from "./client";
import { readApiKeyAuthForConnection } from "./api-key";
import { builtInClientPolicy, builtInProviderForEndpoint } from "./built-ins";
import { getMcpEndpointAuthorizer } from "./endpoint-authorization";
import { boundedMcpErrorText, isMcpAuthorizationChallenge, McpClientError } from "./errors";
import {
  compareAndSetCatalogRevision,
  deleteOwnedConnection,
  insertCatalogRevision,
  readConnection,
  readOwnedConnection,
  renameOwnedConnection,
  updateConnection,
  type McpConnectionRemovalGate,
  type McpConnectionRemovalOutcome,
  type McpConnectionWithServer,
  type McpConnectionUpdate,
} from "./persistence";
import type { McpNegotiatedServer } from "./protocol";
import { McpOAuthAuthorizationRequiredError, mcpOAuthProviderForConnection } from "./oauth";
import { startMcpTraceSpan, type McpTraceContext } from "./trace";

export type McpClientFactory = (
  connection: McpConnectionWithServer,
) => McpRawClient | Promise<McpRawClient>;

export interface McpConnectionManagerPersistence {
  readConnection: typeof readConnection;
  readOwnedConnection: typeof readOwnedConnection;
  updateConnection: typeof updateConnection;
  renameOwnedConnection: typeof renameOwnedConnection;
  deleteOwnedConnection: typeof deleteOwnedConnection;
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
  renameOwnedConnection,
  deleteOwnedConnection,
  insertCatalogRevision,
  compareAndSetCatalogRevision,
};

/** Rename result, one per HTTP route branch. */
export type McpConnectionRenameOutcome =
  | { outcome: "renamed"; id: string; label: string }
  | { outcome: "not_found" }
  | { outcome: "built_in" };

const MAX_CATALOG_STABILIZATION_ATTEMPTS = 3;

/**
 * A disconnect also clears the revision pointer: catalog readers check the
 * pointer, not `status`. Unconditional, not compare-and-set.
 */
const DISCONNECTED_PATCH: McpConnectionUpdate = {
  status: "disconnected",
  currentCatalogRevisionId: null,
};

interface CatalogRefreshState {
  dirty: boolean;
  promise: Promise<void>;
  generation: McpManagerGeneration;
}

type McpManagerCloseIntent =
  | "shutdown"
  | "failure"
  | "disconnect"
  // Close only; the row is already deleted.
  | "removal"
  // Close only; the next generation writes the status.
  | "credential_replaced";

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
 * Pick the auth mode for a stored connection: API key first, then OAuth, else `none`.
 * The client cannot import `@alfred/db`, so this is the only production resolver.
 */
async function resolveMcpClientAuth(connection: McpConnectionWithServer): Promise<McpClientAuth> {
  const reader = await readApiKeyAuthForConnection(connection.id, connection.userId);

  if (reader !== undefined) return { mode: "api_key", reader };

  if (connection.credentialId !== null || connection.authServerIdentity !== null) {
    return {
      mode: "oauth",
      provider: (authorization) =>
        mcpOAuthProviderForConnection({
          id: connection.id,
          userId: connection.userId,
          authorization,
        }),
    };
  }

  return { mode: "none" };
}

/** Production factory. The transport gets only a token reader, so it cannot refresh and replay a call. */
function liveClientFactory(): McpClientFactory {
  const endpointAuthorizer = getMcpEndpointAuthorizer();

  return async (connection) => {
    const auth = await resolveMcpClientAuth(connection);

    return new McpRawClient({
      connectionId: connection.id,
      endpoint: connection.server,
      endpointAuthorizer,
      auth,
      // ADR-0094/0095 policy from the registry; the client does not read it itself.
      ...builtInClientPolicy(connection.server.endpointUrl),
      // OAuth only: an API-key connection has no consent screen to send back to.
      ...(auth.mode === "oauth"
        ? {
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
  /** Ids being deleted. Checked at entry and after each await, so no client opens for them. */
  readonly #removals = new Set<string>();
  #shuttingDown = false;

  constructor(options: McpConnectionManagerOptions = {}) {
    this.#clientFactory = options.clientFactory ?? liveClientFactory();
    this.#persistence = options.persistence ?? DEFAULT_PERSISTENCE;
  }

  /** A connected client with a published catalog, cached per connection. On failure, mark the row `failed`. */
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
      client = await this.#clientFactory(connection);
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

      if (
        err instanceof McpOAuthAuthorizationRequiredError ||
        (connection.credentialId !== null && isMcpAuthorizationChallenge(err))
      ) {
        await client.close().catch(() => undefined);
        this.#assertOpenGeneration(generation);
        await this.#patch(connectionId, {
          status: "auth_required",
          lastError:
            err instanceof McpOAuthAuthorizationRequiredError
              ? "Authorization is required to connect this MCP server."
              : boundedMcpErrorText(err),
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
      // Not `toMessage`: the SDK error holds the whole response body.
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

  /** Refresh and publish the catalog. An unchanged catalog only updates `lastConnectedAt`. */
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

  /** Send a validated call. The broker owns the ledger. */
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

  /**
   * Reopen the connection. On failure, restore the old status and revision
   * pointer and record `lastError`, so a failed reconnect never loses a working catalog.
   * `false` means not found or not the caller's.
   */
  async reconnect(connectionId: string, userId: string): Promise<boolean> {
    const before = await this.#persistence.readOwnedConnection(connectionId, userId);

    if (!before) return false;
    await this.disconnect(connectionId, userId);

    try {
      await this.getReadyClient(connectionId);
    } catch (error) {
      await this.#patch(connectionId, {
        status: before.status,
        currentCatalogRevisionId: before.currentCatalogRevisionId,
        lastError: boundedMcpErrorText(error),
      });
      throw error;
    }

    return true;
  }

  /** Rename an owned connection. Built-ins are refused: `ensureBuiltInConnection` resets their label. */
  async rename(
    connectionId: string,
    userId: string,
    label: string,
  ): Promise<McpConnectionRenameOutcome> {
    const owned = await this.#persistence.readOwnedConnection(connectionId, userId);

    if (!owned) return { outcome: "not_found" };

    if (builtInProviderForEndpoint(owned.server.endpointUrl) !== undefined) {
      return { outcome: "built_in" };
    }

    const renamed = await this.#persistence.renameOwnedConnection({
      connectionId,
      userId,
      label,
    });

    if (!renamed) return { outcome: "not_found" };

    return { outcome: "renamed", id: renamed.id, label: renamed.label };
  }

  /**
   * Delete an owned connection. Raise the fence before the delete; close the
   * client only if a row was removed. Skip `gate` only with an explicit `"none"`.
   */
  async remove(
    connectionId: string,
    userId: string,
    gate: McpConnectionRemovalGate | "none",
  ): Promise<McpConnectionRemovalOutcome> {
    this.#removals.add(connectionId);

    try {
      const outcome = await this.#persistence.deleteOwnedConnection({
        connectionId,
        userId,
        gate,
      });

      if (outcome !== "removed") return outcome;

      const generation = this.#beginClosing(connectionId);
      await this.#closeGeneration(generation, "removal");

      return "removed";
    } finally {
      this.#removals.delete(connectionId);
    }
  }

  /**
   * Drop the cached client so the next call reads the new credential.
   * The cached key reader still holds the old key. Never overrides a disconnect or failure.
   */
  async invalidateLiveClient(connectionId: string): Promise<void> {
    const generation = this.#generations.get(connectionId);

    if (!generation) return;

    await this.#closeGeneration(generation, "credential_replaced");
  }

  /** Drop all live clients, for shutdown. Rows are untouched. */
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

  /** Publish only a snapshot still live after the transaction; a list-change event forces one more loop. */
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

      // An event beat pointer activation. Remove the stale entry before the retry.
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
    // Observe the rejection even with no waiter; awaiters still get it.
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
      // Fail closed: do not serve the invalidated revision while fetching.
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
      // Do not await here: the closer waits on this promise, so awaiting would deadlock.
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
    if (
      this.#shuttingDown ||
      this.#removals.has(connectionId) ||
      this.#generations.get(connectionId)?.phase === "closing"
    ) {
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
      !this.#removals.has(generation.connectionId) &&
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

    // `disconnect` and `removal` always win; `failure` cannot override them.
    // `shutdown` and `credential_replaced` apply only when nothing stronger is set.
    if (
      intent === "disconnect" ||
      intent === "removal" ||
      (intent === "failure" &&
        generation.closeIntent !== "disconnect" &&
        generation.closeIntent !== "removal") ||
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
        await this.#patch(generation.connectionId, DISCONNECTED_PATCH);
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
          await this.#patch(generation.connectionId, DISCONNECTED_PATCH);
        }
      }

      if (this.#generations.get(generation.connectionId) === generation) {
        this.#generations.delete(generation.connectionId);
      }
    })());
  }
}
