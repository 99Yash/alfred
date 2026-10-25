/**
 * Builds live `McpRawClient`s from `mcp_connections` rows on demand: connect,
 * refresh the catalog, insert the revision, and promote it only while that generation is live.
 * Tests inject `clientFactory` and `persistence` to run offline.
 *
 * The only Effect module in Alfred (ADR-0114). Rules for an edit here:
 * - Each public method returns a `Promise`. No exported signature names an Effect type.
 * - An interrupt abandons a pending promise; the promise still runs. So code in a lifecycle
 *   fiber reaches persistence only through `lifecycleStore`, where each write is uninterruptible.
 *   The public methods run outside any fiber and call `#persistence` directly.
 * - A scope runs its finalizers in reverse order: fibers forked into it stop before the client closes.
 * - `Effect.forkIn` on a closed scope interrupts the new fiber at once.
 * - At the `Promise` boundary (`#settle`), an interrupt becomes `McpClientError("not_connected")`.
 */

import type { ExternalToolRef } from "@alfred/contracts";
import { Cause, Effect, Exit, Fiber, Scope } from "effect";
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

/** Reconnect result, one per HTTP route branch. */
export type McpConnectionReconnectOutcome =
  | { outcome: "connected" }
  | { outcome: "auth_required" }
  | { outcome: "not_found" }
  | { outcome: "failed"; lastError: string };

const MAX_CATALOG_STABILIZATION_ATTEMPTS = 3;

/**
 * A disconnect also clears the revision pointer: catalog readers check the
 * pointer, not `status`. Unconditional, not compare-and-set.
 */
const DISCONNECTED_PATCH: McpConnectionUpdate = {
  status: "disconnected",
  currentCatalogRevisionId: null,
};

type McpManagerCloseIntent =
  | "shutdown"
  | "failure"
  | "disconnect"
  // Close only; the row is already deleted.
  | "removal"
  // Close only; the next generation writes the status.
  | "credential_replaced";

/**
 * One live client for one connection. `scope` owns the client and every fiber
 * that works on it, so closing the scope interrupts them and then closes the client.
 * A fiber stops at its next step after an interrupt; durable writes finish first (`write`).
 */
interface McpManagerGeneration {
  readonly connectionId: string;
  readonly scope: Scope.Closeable;
  /** Null for a closing tombstone. */
  start: Fiber.Fiber<McpRawClient, unknown> | null;
  /** Set when the start publishes a catalog. */
  client: McpRawClient | null;
  refresh: Fiber.Fiber<void, unknown> | null;
  refreshDirty: boolean;
  /** Set once, by the first close. A closing generation admits no caller. */
  closing: Promise<void> | null;
  closeIntent: McpManagerCloseIntent | null;
  closeFailure: string | null;
}

function newGeneration(connectionId: string): McpManagerGeneration {
  return {
    connectionId,
    scope: Scope.makeUnsafe(),
    start: null,
    client: null,
    refresh: null,
    refreshDirty: false,
    closing: null,
    closeIntent: null,
    closeFailure: null,
  };
}

/** A promise step. An interrupt abandons it at once. */
function step<A>(run: (signal: AbortSignal) => PromiseLike<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: run, catch: (error) => error });
}

/** A durable write. An interrupt waits for it, so a close never races a write it abandoned. */
function write<A>(run: () => PromiseLike<A>): Effect.Effect<A, unknown> {
  return Effect.uninterruptible(step(run));
}

function closeQuietly(client: McpRawClient): Effect.Effect<void> {
  return Effect.promise(() => client.close().catch(() => undefined));
}

function bothSignals(caller: AbortSignal | undefined, fiber: AbortSignal): AbortSignal {
  return caller ? AbortSignal.any([caller, fiber]) : fiber;
}

/**
 * The persistence port for lifecycle fibers (ADR-0114 D3). A read stops on an interrupt.
 * A write cannot be interrupted, so a close waits for a write that started. Code in a
 * lifecycle fiber reaches persistence only through this port. The client's OAuth callbacks
 * write outside it (ADR-0114 residual risk).
 */
function lifecycleStore(persistence: McpConnectionManagerPersistence) {
  return {
    readConnection: (connectionId: string) => step(() => persistence.readConnection(connectionId)),
    updateConnection: (connectionId: string, patch: McpConnectionUpdate) =>
      write(() => persistence.updateConnection(connectionId, patch)),
    insertCatalogRevision: (
      input: Parameters<McpConnectionManagerPersistence["insertCatalogRevision"]>[0],
    ) => write(() => persistence.insertCatalogRevision(input)),
    compareAndSetCatalogRevision: (
      input: Parameters<McpConnectionManagerPersistence["compareAndSetCatalogRevision"]>[0],
    ) => write(() => persistence.compareAndSetCatalogRevision(input)),
  };
}

/** A start failure that writes `auth_required`: the server asks for consent or rejects the stored grant. */
function needsConsent(err: unknown, connection: McpConnectionWithServer): boolean {
  return (
    err instanceof McpOAuthAuthorizationRequiredError ||
    (connection.credentialId !== null && isMcpAuthorizationChallenge(err))
  );
}

class McpConnectionNotFoundError extends Error {
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
  readonly #activeRevisionIds = new Map<string, string>();
  readonly #clientFactory: McpClientFactory;
  readonly #persistence: McpConnectionManagerPersistence;
  readonly #store: ReturnType<typeof lifecycleStore>;
  /** Ids being deleted. Admission refuses them; a successful delete closes the live generation. */
  readonly #removals = new Set<string>();
  #shuttingDown = false;

  constructor(options: McpConnectionManagerOptions = {}) {
    this.#clientFactory = options.clientFactory ?? liveClientFactory();
    this.#persistence = options.persistence ?? DEFAULT_PERSISTENCE;
    this.#store = lifecycleStore(this.#persistence);
  }

  /** A connected client with a published catalog, cached per connection. On failure, mark the row `failed`. */
  async getReadyClient(connectionId: string, trace?: McpTraceContext): Promise<McpRawClient> {
    try {
      return await this.#getReadyClient(connectionId, trace);
    } catch (err) {
      // The start renewed a rejected token. One more start uses it.
      if (!(err instanceof McpClientError) || err.code !== "token_rejected") throw err;

      return this.#getReadyClient(connectionId, trace);
    }
  }

  async #getReadyClient(connectionId: string, trace?: McpTraceContext): Promise<McpRawClient> {
    this.#assertAdmission(connectionId);
    await this.#waitForCatalogRefresh(connectionId);
    this.#assertAdmission(connectionId);
    const current = this.#generations.get(connectionId);

    if (current?.client) return current.client;

    if (current?.start) return this.#settle(connectionId, Fiber.await(current.start));

    const generation = newGeneration(connectionId);
    this.#generations.set(connectionId, generation);
    generation.start = Effect.runFork(this.#startClient(generation, trace));

    return this.#settle(connectionId, Fiber.await(generation.start));
  }

  #startClient(
    generation: McpManagerGeneration,
    trace?: McpTraceContext,
  ): Effect.Effect<McpRawClient, unknown> {
    const { connectionId } = generation;

    return Effect.gen({ self: this }, function* () {
      const connection = yield* this.#store.readConnection(connectionId);

      if (!connection) return yield* Effect.fail(new McpConnectionNotFoundError(connectionId));

      const client = yield* Effect.acquireRelease(
        step(async () => this.#clientFactory(connection)),
        closeQuietly,
      ).pipe(Scope.provide(generation.scope));

      return yield* this.#openClient(generation, client, trace).pipe(
        Effect.catch((err) => this.#settleFailedStart(generation, connection, err)),
      );
    }).pipe(
      // Every failed start leaves the map, so the next caller starts again (ADR-0114 D5).
      // An interrupt is a close, and the close removes the generation itself.
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)
          ? Effect.void
          : Scope.close(generation.scope, Exit.void).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  if (this.#generations.get(connectionId) === generation) {
                    this.#generations.delete(connectionId);
                  }
                }),
              ),
            ),
      ),
    );
  }

  #openClient(
    generation: McpManagerGeneration,
    client: McpRawClient,
    trace?: McpTraceContext,
  ): Effect.Effect<McpRawClient, unknown> {
    const { connectionId } = generation;

    return Effect.gen({ self: this }, function* () {
      yield* this.#store.updateConnection(connectionId, { status: "connecting", lastError: null });

      const connectSpan = startMcpTraceSpan({
        name: "runtime.mcp.connect",
        ...(trace ? { parent: trace } : {}),
        metadata: { connectionId },
      });

      yield* step(() => client.connect(connectSpan.context)).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() =>
            connectSpan.end(
              Exit.isSuccess(exit) ? { status: "connected" } : { status: "error", level: "ERROR" },
            ),
          ),
        ),
      );

      for (let attempt = 1; attempt <= MAX_CATALOG_STABILIZATION_ATTEMPTS; attempt += 1) {
        yield* this.#prepareAndPersistStable(generation, client, undefined, connectSpan.context);

        if (client.catalog) break;

        if (attempt === MAX_CATALOG_STABILIZATION_ATTEMPTS) {
          return yield* Effect.fail(
            new McpClientError(
              "catalog_stale",
              "The MCP catalog kept changing while the connection was starting",
            ),
          );
        }
      }

      generation.client = client;
      // Registered only now: the start loop above already handles an earlier invalidation.
      client.onCatalogInvalidated(() => this.#scheduleCatalogRefresh(generation, client));

      return client;
    });
  }

  /** Close the client, write the row state for this failure, and fail with the original error. */
  #settleFailedStart(
    generation: McpManagerGeneration,
    connection: McpConnectionWithServer,
    err: unknown,
  ): Effect.Effect<never, unknown> {
    const { connectionId } = generation;

    return Effect.gen({ self: this }, function* () {
      if (needsConsent(err, connection)) {
        yield* Scope.close(generation.scope, Exit.void);
        yield* this.#store.updateConnection(connectionId, {
          status: "auth_required",
          lastError:
            err instanceof McpOAuthAuthorizationRequiredError
              ? "Authorization is required to connect this MCP server."
              : boundedMcpErrorText(err),
        });
      } else if (err instanceof McpClientError && err.code === "token_rejected") {
        // A renewed token is not a failure: keep the row and its catalog as they are.
        yield* Scope.close(generation.scope, Exit.void);
      } else {
        const expectedCurrentRevisionId =
          this.#activeRevisionIds.get(connectionId) ?? connection.currentCatalogRevisionId;

        this.#activeRevisionIds.delete(connectionId);
        yield* Scope.close(generation.scope, Exit.void);
        // Not `toMessage`: the SDK error holds the whole response body.
        yield* this.#store.compareAndSetCatalogRevision({
          connectionId,
          expectedCurrentRevisionId,
          nextRevisionId: null,
          patch: { status: "failed", lastError: boundedMcpErrorText(err) },
        });
      }

      return yield* Effect.fail(err);
    });
  }

  /** Refresh and publish the catalog. An unchanged catalog only updates `lastConnectedAt`. */
  async refreshCatalog(connectionId: string, trace?: McpTraceContext): Promise<McpCatalogSnapshot> {
    const client = await this.getReadyClient(connectionId, trace);
    const generation = this.#requireReadyGeneration(connectionId, client);

    return this.#runInGeneration(
      generation,
      this.#prepareAndPersistStable(generation, client, undefined, trace).pipe(
        Effect.map((prepared) => prepared.catalog),
      ),
    );
  }

  async prepareToolCall(
    connectionId: string,
    signal?: AbortSignal,
    trace?: McpTraceContext,
  ): Promise<McpPreparedToolCall> {
    const client = await this.getReadyClient(connectionId, trace);
    const generation = this.#requireReadyGeneration(connectionId, client);

    return this.#runInGeneration(
      generation,
      this.#prepareAndPersistStable(generation, client, signal, trace),
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
    const generation = this.#generations.get(connectionId) ?? this.#tombstone(connectionId);
    await this.#closeGeneration(generation, "disconnect");

    return true;
  }

  /**
   * Reopen the connection. On failure, restore the old status and revision
   * pointer and record `lastError`, so a failed reconnect never loses a working catalog.
   * A consent ask is the exception: the start wrote `auth_required`, and the card offers consent.
   */
  async reconnect(connectionId: string, userId: string): Promise<McpConnectionReconnectOutcome> {
    const before = await this.#persistence.readOwnedConnection(connectionId, userId);

    if (!before) return { outcome: "not_found" };
    await this.disconnect(connectionId, userId);

    try {
      await this.getReadyClient(connectionId);
    } catch (error) {
      if (needsConsent(error, before)) return { outcome: "auth_required" };

      const lastError = boundedMcpErrorText(error);

      await this.#persistence.updateConnection(connectionId, {
        status: before.status,
        currentCatalogRevisionId: before.currentCatalogRevisionId,
        lastError,
      });

      return { outcome: "failed", lastError };
    }

    return { outcome: "connected" };
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

      const generation = this.#generations.get(connectionId) ?? this.#tombstone(connectionId);
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
    await Promise.all(
      [...this.#generations.values()].map((generation) =>
        this.#closeGeneration(generation, "shutdown"),
      ),
    );
  }

  /** Run `effect` as a child of the generation. A close interrupts it; the caller gets `not_connected`. */
  #runInGeneration<A>(
    generation: McpManagerGeneration,
    effect: Effect.Effect<A, unknown>,
  ): Promise<A> {
    return this.#settle(
      generation.connectionId,
      Effect.forkIn(effect, generation.scope).pipe(Effect.flatMap(Fiber.await)),
    );
  }

  /** Turn a fiber outcome back into a Promise result. An interrupt means the generation closed. */
  async #settle<A>(
    connectionId: string,
    outcome: Effect.Effect<Exit.Exit<A, unknown>>,
  ): Promise<A> {
    const exit = await Effect.runPromise(outcome);

    if (Exit.isSuccess(exit)) return exit.value;

    if (Cause.hasInterruptsOnly(exit.cause)) throw this.#notConnected(connectionId);

    throw Cause.squash(exit.cause);
  }

  #insertCatalog(
    connectionId: string,
    snapshot: McpCatalogSnapshot,
  ): Effect.Effect<string, unknown> {
    return this.#store
      .insertCatalogRevision({
        connectionId,
        revisionHash: snapshot.revision,
        descriptors: snapshot.tools,
      })
      .pipe(Effect.map((revision) => revision.id));
  }

  #activateCatalog(
    connectionId: string,
    expectedCurrentRevisionId: string | null,
    revisionId: string,
    negotiated: McpNegotiatedServer | null,
  ): Effect.Effect<boolean, unknown> {
    return this.#store
      .compareAndSetCatalogRevision({
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
      })
      .pipe(Effect.map((activated) => activated !== undefined));
  }

  /** Publish only a snapshot still live after the transaction; a list-change event forces one more loop. */
  #prepareAndPersistStable(
    generation: McpManagerGeneration,
    client: McpRawClient,
    signal: AbortSignal | undefined,
    trace: McpTraceContext | undefined,
  ): Effect.Effect<McpPreparedToolCall, unknown> {
    const { connectionId } = generation;

    return Effect.suspend(() => {
      const span = startMcpTraceSpan({
        name: "runtime.mcp.catalog_refresh",
        ...(trace ? { parent: trace } : {}),
        metadata: { connectionId },
      });

      return this.#prepareAndPersistStableInner(generation, client, signal, span.context).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() =>
            Exit.isSuccess(exit)
              ? span.end({
                  status: "ready",
                  metadata: {
                    catalogRevision: exit.value.catalog.revision,
                    toolCount: exit.value.catalog.tools.length,
                  },
                })
              : span.end({ status: "error", level: "ERROR" }),
          ),
        ),
      );
    });
  }

  #prepareAndPersistStableInner(
    generation: McpManagerGeneration,
    client: McpRawClient,
    signal: AbortSignal | undefined,
    trace: McpTraceContext,
  ): Effect.Effect<McpPreparedToolCall, unknown> {
    const { connectionId } = generation;

    return Effect.gen({ self: this }, function* () {
      for (let attempt = 1; attempt <= MAX_CATALOG_STABILIZATION_ATTEMPTS; attempt += 1) {
        const durableBefore = yield* this.#store.readConnection(connectionId);

        if (!durableBefore) return yield* Effect.fail(new McpConnectionNotFoundError(connectionId));
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

        const prepared = yield* step((fiberSignal) =>
          client.prepareToolCall(bothSignals(signal, fiberSignal), trace),
        ).pipe(
          Effect.catchIf(
            (err) =>
              err instanceof McpClientError &&
              err.code === "catalog_stale" &&
              attempt < MAX_CATALOG_STABILIZATION_ATTEMPTS,
            () => Effect.succeed(null),
          ),
        );

        if (!prepared) continue;
        const snapshot = prepared.catalog;

        if (
          snapshot === priorCatalog &&
          activeRevisionId !== undefined &&
          durableBefore.currentCatalogRevisionId === activeRevisionId
        ) {
          return prepared;
        }

        const revisionId = yield* this.#insertCatalog(connectionId, snapshot);

        if (client.catalog !== snapshot) continue;

        const activated = yield* this.#activateCatalog(
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

        // An event beat pointer activation. Remove the stale entry before the retry.
        yield* this.#store.compareAndSetCatalogRevision({
          connectionId,
          expectedCurrentRevisionId: revisionId,
          nextRevisionId: null,
          patch: { status: "stale" },
        });
        this.#activeRevisionIds.delete(connectionId);
      }

      return yield* Effect.fail(
        new McpClientError(
          "catalog_stale",
          `The MCP catalog changed during ${MAX_CATALOG_STABILIZATION_ATTEMPTS} consecutive refresh attempts`,
        ),
      );
    });
  }

  /**
   * Coalesce list-change bursts into one durable invalidate → refresh cycle.
   * The refresh fiber lives in the generation scope; a refresh failure closes the generation.
   */
  #scheduleCatalogRefresh(generation: McpManagerGeneration, client: McpRawClient): void {
    if (generation.closing) return;
    generation.refreshDirty = true;

    if (generation.refresh) return;

    const refresh = Effect.runFork(
      Effect.forkIn(this.#drainCatalogRefreshes(generation, client), generation.scope).pipe(
        Effect.flatMap(Fiber.join),
      ),
    );

    generation.refresh = refresh;
    refresh.addObserver((exit) => {
      generation.refresh = null;

      // An event after the drain loop's last check set the flag, but saw a refresh still running.
      if (Exit.isSuccess(exit)) {
        if (generation.refreshDirty) this.#scheduleCatalogRefresh(generation, client);

        return;
      }

      // An interrupt is a close; a failure during a close is not a refresh failure.
      if (Cause.hasInterruptsOnly(exit.cause) || generation.closing) return;
      void this.#closeGeneration(
        generation,
        "failure",
        boundedMcpErrorText(Cause.squash(exit.cause)),
      ).catch(() => undefined);
    });
  }

  #drainCatalogRefreshes(
    generation: McpManagerGeneration,
    client: McpRawClient,
  ): Effect.Effect<void, unknown> {
    const { connectionId } = generation;

    return Effect.gen({ self: this }, function* () {
      while (generation.refreshDirty) {
        generation.refreshDirty = false;
        // Fail closed: do not serve the invalidated revision while fetching.
        const expectedCurrentRevisionId = this.#activeRevisionIds.get(connectionId) ?? null;
        yield* this.#store.compareAndSetCatalogRevision({
          connectionId,
          expectedCurrentRevisionId,
          nextRevisionId: null,
          patch: { status: "stale", lastError: null },
        });
        this.#activeRevisionIds.delete(connectionId);
        yield* this.#prepareAndPersistStable(generation, client, undefined, undefined);
      }
    });
  }

  async #waitForCatalogRefresh(connectionId: string): Promise<void> {
    for (;;) {
      const refresh = this.#generations.get(connectionId)?.refresh;

      if (!refresh) return;
      await Effect.runPromise(Fiber.await(refresh));
    }
  }

  #assertAdmission(connectionId: string): void {
    if (
      this.#shuttingDown ||
      this.#removals.has(connectionId) ||
      this.#generations.get(connectionId)?.closing
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

  #requireReadyGeneration(connectionId: string, client: McpRawClient): McpManagerGeneration {
    const generation = this.#generations.get(connectionId);

    if (!generation || generation.closing || generation.client !== client) {
      throw this.#notConnected(connectionId);
    }

    return generation;
  }

  /** A closing placeholder with no client: admission refuses the id until its close finishes. */
  #tombstone(connectionId: string): McpManagerGeneration {
    const tombstone = newGeneration(connectionId);
    this.#generations.set(connectionId, tombstone);

    return tombstone;
  }

  #closeGeneration(
    generation: McpManagerGeneration,
    intent: McpManagerCloseIntent,
    failure?: string,
  ): Promise<void> {
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

    return (generation.closing ??= Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const { connectionId } = generation;

        // The start and every fiber in the scope stop at their next step; the scope then closes the client.
        if (generation.start) yield* Fiber.interrupt(generation.start);
        yield* Scope.close(generation.scope, Exit.void);
        this.#activeRevisionIds.delete(connectionId);
        const selectedIntent = generation.closeIntent;

        if (selectedIntent === "disconnect") {
          yield* this.#store.updateConnection(connectionId, DISCONNECTED_PATCH);
        } else if (selectedIntent === "failure") {
          yield* this.#store.compareAndSetCatalogRevision({
            connectionId,
            expectedCurrentRevisionId: null,
            nextRevisionId: null,
            patch: {
              status: "failed",
              lastError: generation.closeFailure ?? "The MCP catalog refresh failed",
            },
          });

          if (generation.closeIntent === "disconnect") {
            yield* this.#store.updateConnection(connectionId, DISCONNECTED_PATCH);
          }
        }

        if (this.#generations.get(connectionId) === generation) {
          this.#generations.delete(connectionId);
        }
      }),
    ));
  }
}
