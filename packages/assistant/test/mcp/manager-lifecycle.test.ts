import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Tool } from "@modelcontextprotocol/client";

import {
  McpClientError,
  McpConnectionManager,
  McpRawClient,
  type McpConnectionManagerPersistence,
  type McpNegotiatedServer,
  type McpProtocolCallResult,
  type McpProtocolClient,
  type McpProtocolPage,
  type McpTraceContext,
} from "@alfred/assistant/connections/mcp";
import { permissiveMcpEndpointAuthorizerForTests } from "@alfred/assistant/connections/mcp/test-support";
import type { McpConnectionWithServer } from "../../src/connections/mcp/persistence";

type JoinedServerDefinition = McpConnectionWithServer["server"];
// @ts-expect-error - consumers receive definition facts, not a second owner identity.
type _NoJoinedServerOwner = JoinedServerDefinition["userId"];
// @ts-expect-error - the connection's serverId is authoritative; the nested row does not repeat it.
type _NoJoinedServerId = JoinedServerDefinition["id"];

class FakeProtocol implements McpProtocolClient {
  tools: Tool[] = [tool("tool_a")];
  connectCount = 0;
  closeCount = 0;
  listCount = 0;
  ttlMs = 0;
  onListTools: (() => void | Promise<void>) | null = null;
  onConnect: (() => void | Promise<void>) | null = null;
  onClose: (() => void | Promise<void>) | null = null;
  connectTrace: McpTraceContext | undefined;
  listTraces: Array<McpTraceContext | undefined> = [];
  #toolsChanged: (() => void | Promise<void>) | null = null;

  async connect(trace?: McpTraceContext): Promise<McpNegotiatedServer> {
    this.connectCount += 1;
    this.connectTrace = trace;
    await this.onConnect?.();
    return {
      protocolEra: "pre_2026_07_28",
      protocolVersion: "2025-11-25",
      serverName: "fake",
      serverVersion: "1",
      hasTools: true,
      toolsListChanged: true,
    };
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    await this.onClose?.();
  }

  async listTools(
    _cursor?: string,
    _signal?: AbortSignal,
    trace?: McpTraceContext,
  ): Promise<McpProtocolPage> {
    this.listCount += 1;
    this.listTraces.push(trace);
    await this.onListTools?.();
    return { tools: this.tools, ttlMs: this.ttlMs, cacheScope: "private" };
  }

  async callTool(): Promise<McpProtocolCallResult> {
    return { content: [{ type: "text", text: "ok" }] };
  }

  onToolsChanged(handler: () => void | Promise<void>): void {
    this.#toolsChanged = handler;
  }

  onConnectionUnhealthy(): void {}

  async emitToolsChanged(): Promise<void> {
    await this.#toolsChanged?.();
  }
}

class MemoryPersistence implements McpConnectionManagerPersistence {
  readonly connection = connection();
  readonly revisions = new Map<string, string[]>();
  publications = 0;
  readonly updates: Array<Partial<McpConnection>> = [];
  onPublish: (() => void | Promise<void>) | null = null;
  onReadOwned: (() => void | Promise<void>) | null = null;
  onUpdate: ((patch: Partial<McpConnection>) => void | Promise<void>) | null = null;
  onActivate:
    | ((
        input: Parameters<McpConnectionManagerPersistence["compareAndSetCatalogRevision"]>[0],
      ) => void | Promise<void>)
    | null = null;

  readConnection: McpConnectionManagerPersistence["readConnection"] = async (id) =>
    id === this.connection.id ? this.connection : undefined;

  readOwnedConnection: McpConnectionManagerPersistence["readOwnedConnection"] = async (
    id,
    userId,
  ) => {
    await this.onReadOwned?.();
    return id === this.connection.id && userId === this.connection.userId
      ? this.connection
      : undefined;
  };

  updateConnection: McpConnectionManagerPersistence["updateConnection"] = async (id, patch) => {
    if (id !== this.connection.id) return undefined;
    this.updates.push(patch);
    await this.onUpdate?.(patch);
    Object.assign(this.connection, patch, { updatedAt: new Date() });
    return this.connection;
  };

  insertCatalogRevision: McpConnectionManagerPersistence["insertCatalogRevision"] = async (
    input,
  ) => {
    this.publications += 1;
    await this.onPublish?.();
    const now = new Date();
    const id = `revision-${this.publications}`;
    this.revisions.set(
      id,
      Array.isArray(input.descriptors)
        ? input.descriptors.flatMap((entry) =>
            typeof entry === "object" &&
            entry !== null &&
            "name" in entry &&
            typeof entry.name === "string"
              ? [entry.name]
              : [],
          )
        : [],
    );
    return {
      id,
      connectionId: input.connectionId,
      revisionHash: input.revisionHash,
      descriptors: input.descriptors,
      descriptorHashes: input.descriptorHashes,
      readOnlyHints: input.readOnlyHints,
      toolCount: input.toolCount,
      createdAt: now,
      updatedAt: now,
    };
  };

  compareAndSetCatalogRevision: McpConnectionManagerPersistence["compareAndSetCatalogRevision"] =
    async (input) => {
      if (input.nextRevisionId) await this.onActivate?.(input);
      if (
        input.connectionId !== this.connection.id ||
        this.connection.currentCatalogRevisionId !== input.expectedCurrentRevisionId
      ) {
        return undefined;
      }
      Object.assign(this.connection, input.patch, {
        currentCatalogRevisionId: input.nextRevisionId,
        updatedAt: new Date(),
      });
      return this.connection;
    };
}

function managerWith(
  protocol: FakeProtocol,
  persistence: MemoryPersistence,
  now?: () => number,
): McpConnectionManager {
  return new McpConnectionManager({
    persistence,
    clientFactory: (row) =>
      new McpRawClient({
        connectionId: row.id,
        endpoint: row.server,
        endpointAuthorizer: permissiveMcpEndpointAuthorizerForTests(),
        protocolFactory: () => protocol,
        ...(now ? { now } : {}),
      }),
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("mcp connection manager lifecycle", () => {
  test("clears a published pointer when stabilization fails", async () => {
    const protocol = new FakeProtocol();
    const persistence = new MemoryPersistence();
    const manager = managerWith(protocol, persistence);
    let listCalls = 0;

    protocol.onListTools = () => {
      listCalls += 1;
      if (listCalls === 2) throw new Error("replacement refresh failed");
    };
    persistence.onPublish = async () => {
      persistence.onPublish = null;
      await protocol.emitToolsChanged();
    };

    await assert.rejects(manager.getReadyClient(persistence.connection.id));
    assert.equal(persistence.connection.status, "failed");
    assert.equal(persistence.connection.currentCatalogRevisionId, null);
  });

  test("coalesces a list-change burst without reconnecting", async () => {
    const protocol = new FakeProtocol();
    const persistence = new MemoryPersistence();
    const manager = managerWith(protocol, persistence);

    await manager.getReadyClient(persistence.connection.id);
    protocol.tools = [tool("tool_b")];
    let injectedSecondChange = false;
    protocol.onListTools = async () => {
      if (injectedSecondChange) return;
      injectedSecondChange = true;
      await protocol.emitToolsChanged();
    };

    await protocol.emitToolsChanged();
    const client = await manager.getReadyClient(persistence.connection.id);

    assert.equal(protocol.connectCount, 1);
    assert.deepEqual(
      client.catalog?.tools.map((entry) => entry.name),
      ["tool_b"],
    );
    assert.equal(persistence.connection.status, "ready");
  });

  test("repeats initial publication when invalidated before handler handoff", async () => {
    const protocol = new FakeProtocol();
    const persistence = new MemoryPersistence();
    const manager = managerWith(protocol, persistence);
    let invalidated = false;

    persistence.onActivate = async () => {
      if (invalidated) return;
      invalidated = true;
      protocol.tools = [tool("tool_b")];
      await protocol.emitToolsChanged();
    };

    const client = await manager.getReadyClient(persistence.connection.id);

    assert.deepEqual(
      client.catalog?.tools.map((entry) => entry.name),
      ["tool_b"],
    );
    assert.equal(protocol.listCount, 2);
    assert.deepEqual(
      persistence.revisions.get(persistence.connection.currentCatalogRevisionId ?? ""),
      ["tool_b"],
    );
  });

  test("a losing durable promotion refetches before it can activate", async () => {
    const protocolA = new FakeProtocol();
    const protocolB = new FakeProtocol();
    protocolA.tools = [tool("tool_a")];
    protocolB.tools = [tool("tool_b")];
    const persistence = new MemoryPersistence();
    const managerA = managerWith(protocolA, persistence);
    const managerB = managerWith(protocolB, persistence);
    let releaseA: (() => void) | undefined;
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let aReachedPromotion: (() => void) | undefined;
    const aAtPromotion = new Promise<void>((resolve) => {
      aReachedPromotion = resolve;
    });
    let firstA = true;

    persistence.onActivate = async (input) => {
      const names = persistence.revisions.get(input.nextRevisionId ?? "");
      if (firstA && names?.[0] === "tool_a") {
        firstA = false;
        aReachedPromotion?.();
        await holdA;
      }
    };

    const startA = managerA.getReadyClient(persistence.connection.id);
    await aAtPromotion;
    await managerB.getReadyClient(persistence.connection.id);
    protocolA.tools = [tool("tool_b")];
    releaseA?.();
    await startA;

    assert.equal(protocolA.listCount, 2, "the CAS loser must fetch again");
    assert.deepEqual(
      persistence.revisions.get(persistence.connection.currentCatalogRevisionId ?? ""),
      ["tool_b"],
    );
  });

  test("publishes a replacement catalog before preparing a call after TTL expiry", async () => {
    let now = 1_000;
    const protocol = new FakeProtocol();
    protocol.ttlMs = 1_000;
    const persistence = new MemoryPersistence();
    const manager = managerWith(protocol, persistence, () => now);

    await manager.getReadyClient(persistence.connection.id);
    await manager.prepareToolCall(persistence.connection.id);
    assert.equal(protocol.listCount, 1);
    assert.equal(persistence.publications, 1);

    now += 1_001;
    protocol.tools = [tool("tool_b")];
    const prepared = await manager.prepareToolCall(persistence.connection.id);

    assert.equal(protocol.listCount, 2);
    assert.equal(persistence.publications, 2);
    assert.deepEqual(
      prepared.catalog.tools.map((entry) => entry.name),
      ["tool_b"],
    );
    assert.equal(persistence.connection.currentCatalogRevisionId, "revision-2");
  });

  test("a durable pointer change overrides a TTL-held local catalog", async () => {
    const protocol = new FakeProtocol();
    protocol.ttlMs = 60_000;
    const persistence = new MemoryPersistence();
    const manager = managerWith(protocol, persistence);

    await manager.getReadyClient(persistence.connection.id);
    assert.equal(protocol.listCount, 1);

    persistence.connection.currentCatalogRevisionId = "revision-from-another-worker";
    protocol.tools = [tool("tool_b")];
    const prepared = await manager.prepareToolCall(persistence.connection.id);

    assert.equal(protocol.listCount, 2);
    assert.deepEqual(
      prepared.catalog.tools.map((entry) => entry.name),
      ["tool_b"],
    );
    assert.deepEqual(
      persistence.revisions.get(persistence.connection.currentCatalogRevisionId ?? ""),
      ["tool_b"],
    );
  });

  test("disconnect cancels publication from a refresh that races with its ownership check", async () => {
    const protocol = new FakeProtocol();
    const persistence = new MemoryPersistence();
    const manager = managerWith(protocol, persistence);

    await manager.getReadyClient(persistence.connection.id);
    const disconnect = manager.disconnect(persistence.connection.id, persistence.connection.userId);
    await protocol.emitToolsChanged();
    await disconnect;

    assert.equal(protocol.listCount, 1, "the closing generation must not fetch or publish again");
    assert.equal(persistence.publications, 1);
    assert.equal(persistence.connection.status, "disconnected");
  });

  test("disconnect rejects new admission until its closing tombstone is removed", async () => {
    const protocol = new FakeProtocol();
    const persistence = new MemoryPersistence();
    const manager = managerWith(protocol, persistence);
    await manager.getReadyClient(persistence.connection.id);
    const disconnectedPatchStarted = deferred();
    const releaseDisconnectedPatch = deferred();
    persistence.onUpdate = async (patch) => {
      if (patch.status !== "disconnected") return;
      disconnectedPatchStarted.resolve();
      await releaseDisconnectedPatch.promise;
    };

    const disconnect = manager.disconnect(persistence.connection.id, persistence.connection.userId);
    await disconnectedPatchStarted.promise;
    await assert.rejects(
      manager.getReadyClient(persistence.connection.id),
      (error: unknown) => error instanceof McpClientError && error.code === "not_connected",
    );
    assert.equal(protocol.connectCount, 1);

    releaseDisconnectedPatch.resolve();
    await disconnect;
    persistence.onUpdate = null;
    await manager.getReadyClient(persistence.connection.id);
    assert.equal(protocol.connectCount, 2);
  });

  test("failed startup cannot retire a disconnect tombstone", async () => {
    const protocol = new FakeProtocol();
    const persistence = new MemoryPersistence();
    const manager = managerWith(protocol, persistence);
    const closeStarted = deferred();
    const releaseClose = deferred();
    const ownershipRead = deferred();
    const disconnectedPatchStarted = deferred();
    const releaseDisconnectedPatch = deferred();
    protocol.onListTools = () => {
      throw new Error("initial catalog failed");
    };
    protocol.onClose = async () => {
      closeStarted.resolve();
      await releaseClose.promise;
    };
    persistence.onReadOwned = () => ownershipRead.resolve();
    persistence.onUpdate = async (patch) => {
      if (patch.status !== "disconnected") return;
      disconnectedPatchStarted.resolve();
      await releaseDisconnectedPatch.promise;
    };

    const startup = manager.getReadyClient(persistence.connection.id);
    await closeStarted.promise;
    const disconnect = manager.disconnect(persistence.connection.id, persistence.connection.userId);
    await ownershipRead.promise;
    await Promise.resolve();
    await assert.rejects(
      manager.getReadyClient(persistence.connection.id),
      (error: unknown) => error instanceof McpClientError && error.code === "not_connected",
    );

    releaseClose.resolve();
    await assert.rejects(
      startup,
      (error: unknown) => error instanceof McpClientError && error.code === "not_connected",
    );
    await disconnectedPatchStarted.promise;
    await assert.rejects(
      manager.getReadyClient(persistence.connection.id),
      (error: unknown) => error instanceof McpClientError && error.code === "not_connected",
    );
    assert.equal(protocol.connectCount, 1);

    releaseDisconnectedPatch.resolve();
    await disconnect;
    protocol.onListTools = null;
    protocol.onClose = null;
    persistence.onReadOwned = null;
    persistence.onUpdate = null;
    await manager.getReadyClient(persistence.connection.id);
    assert.equal(protocol.connectCount, 2);
  });

  test("failed background refresh cannot retire a disconnect tombstone", async () => {
    const protocol = new FakeProtocol();
    const persistence = new MemoryPersistence();
    const manager = managerWith(protocol, persistence);
    await manager.getReadyClient(persistence.connection.id);
    const closeStarted = deferred();
    const releaseClose = deferred();
    const disconnectedPatchStarted = deferred();
    const releaseDisconnectedPatch = deferred();
    protocol.onListTools = () => {
      throw new Error("replacement catalog failed");
    };
    protocol.onClose = async () => {
      closeStarted.resolve();
      await releaseClose.promise;
    };
    persistence.onUpdate = async (patch) => {
      if (patch.status !== "disconnected") return;
      disconnectedPatchStarted.resolve();
      await releaseDisconnectedPatch.promise;
    };

    await protocol.emitToolsChanged();
    await closeStarted.promise;
    const disconnect = manager.disconnect(persistence.connection.id, persistence.connection.userId);
    await assert.rejects(
      manager.getReadyClient(persistence.connection.id),
      (error: unknown) => error instanceof McpClientError && error.code === "not_connected",
    );

    releaseClose.resolve();
    await disconnectedPatchStarted.promise;
    await assert.rejects(
      manager.getReadyClient(persistence.connection.id),
      (error: unknown) => error instanceof McpClientError && error.code === "not_connected",
    );
    assert.equal(protocol.connectCount, 1);

    releaseDisconnectedPatch.resolve();
    await disconnect;
    assert.equal(protocol.closeCount, 1);
    assert.equal(persistence.connection.status, "disconnected");
    assert.equal(persistence.updates.filter((patch) => patch.status === "failed").length, 0);
  });

  test("disconnect overrides failure after its terminal compare-and-set starts", async () => {
    const protocol = new FakeProtocol();
    const persistence = new MemoryPersistence();
    const manager = managerWith(protocol, persistence);
    await manager.getReadyClient(persistence.connection.id);
    const failureWriteStarted = deferred();
    const releaseFailureWrite = deferred();
    const ownershipRead = deferred();
    const terminalWrites: Array<Partial<McpConnection>["status"]> = [];
    const compareAndSetCatalogRevision = persistence.compareAndSetCatalogRevision;
    persistence.compareAndSetCatalogRevision = async (input) => {
      terminalWrites.push(input.patch.status);
      if (input.patch.status === "failed") {
        failureWriteStarted.resolve();
        await releaseFailureWrite.promise;
      }
      return compareAndSetCatalogRevision(input);
    };
    persistence.onReadOwned = () => ownershipRead.resolve();
    protocol.onListTools = () => {
      throw new Error("replacement catalog failed");
    };

    await protocol.emitToolsChanged();
    await failureWriteStarted.promise;
    const disconnect = manager.disconnect(persistence.connection.id, persistence.connection.userId);
    await ownershipRead.promise;
    await Promise.resolve();
    releaseFailureWrite.resolve();

    assert.equal(await disconnect, true);
    assert.equal(persistence.connection.status, "disconnected");
    assert.deepEqual(
      persistence.updates.map((patch) => patch.status).filter((status) => status !== undefined),
      ["connecting", "disconnected"],
    );
    assert.deepEqual(terminalWrites, ["stale", "failed"]);
    assert.equal(protocol.closeCount, 1);
  });

  test("disconnect intent survives closeAll in either call order", async () => {
    for (const disconnectFirst of [false, true]) {
      const protocol = new FakeProtocol();
      const persistence = new MemoryPersistence();
      const manager = managerWith(protocol, persistence);
      await manager.getReadyClient(persistence.connection.id);
      const closeStarted = deferred();
      const releaseClose = deferred();
      protocol.onClose = async () => {
        closeStarted.resolve();
        await releaseClose.promise;
      };

      let disconnect: Promise<boolean>;
      let closeAll: Promise<void>;
      if (disconnectFirst) {
        disconnect = manager.disconnect(persistence.connection.id, persistence.connection.userId);
        await closeStarted.promise;
        closeAll = manager.closeAll();
      } else {
        closeAll = manager.closeAll();
        await closeStarted.promise;
        disconnect = manager.disconnect(persistence.connection.id, persistence.connection.userId);
      }
      await Promise.resolve();
      releaseClose.resolve();

      assert.equal(await disconnect, true, disconnectFirst ? "disconnect first" : "closeAll first");
      await closeAll;
      assert.equal(persistence.connection.status, "disconnected");
      assert.equal(
        persistence.updates.filter((patch) => patch.status === "disconnected").length,
        1,
      );
      assert.equal(protocol.closeCount, 1);
    }
  });

  test("closeAll rejects admission and prevents a pending startup from publishing", async () => {
    const protocol = new FakeProtocol();
    const persistence = new MemoryPersistence();
    const manager = managerWith(protocol, persistence);
    const connectStarted = deferred();
    const releaseConnect = deferred();
    protocol.onConnect = async () => {
      connectStarted.resolve();
      await releaseConnect.promise;
    };

    const startup = manager.getReadyClient(persistence.connection.id);
    await connectStarted.promise;
    const close = manager.closeAll();
    await assert.rejects(
      manager.getReadyClient(persistence.connection.id),
      (error: unknown) => error instanceof McpClientError && error.code === "not_connected",
    );
    releaseConnect.resolve();
    await assert.rejects(
      startup,
      (error: unknown) => error instanceof McpClientError && error.code === "not_connected",
    );
    await close;

    await assert.rejects(
      manager.getReadyClient(persistence.connection.id),
      (error: unknown) => error instanceof McpClientError && error.code === "not_connected",
    );

    assert.equal(protocol.connectCount, 1);
    assert.equal(protocol.closeCount, 1);
    assert.equal(persistence.publications, 0);
  });

  test("disconnect refuses a connection owned by another user before mutation", async () => {
    const protocol = new FakeProtocol();
    const persistence = new MemoryPersistence();
    const manager = managerWith(protocol, persistence);

    await manager.getReadyClient(persistence.connection.id);
    const disconnected = await manager.disconnect(persistence.connection.id, "another-user");

    assert.equal(disconnected, false);
    assert.equal(persistence.connection.status, "ready");
    assert.equal(protocol.connectCount, 1);
  });

  test("cold connect and catalog refresh inherit the invocation trace", async () => {
    const protocol = new FakeProtocol();
    const persistence = new MemoryPersistence();
    const manager = managerWith(protocol, persistence);
    const parent: McpTraceContext = {
      runId: "run-trace",
      traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    };

    await manager.prepareToolCall(persistence.connection.id, undefined, parent);

    const traceId = (trace: McpTraceContext | undefined) => trace?.traceparent.split("-")[1];
    assert.equal(traceId(protocol.connectTrace), traceId(parent));
    assert.ok(protocol.listTraces.length > 0);
    for (const trace of protocol.listTraces) {
      assert.equal(traceId(trace), traceId(parent));
      assert.equal(trace?.runId, parent.runId);
    }
  });

  test("bounds repeated invalidation during publication", async () => {
    const protocol = new FakeProtocol();
    const persistence = new MemoryPersistence();
    const manager = managerWith(protocol, persistence);

    persistence.onPublish = async () => {
      if (persistence.publications >= 5) throw new Error("test publication fuse");
      await protocol.emitToolsChanged();
    };

    await assert.rejects(
      manager.getReadyClient(persistence.connection.id),
      (err: unknown) => err instanceof McpClientError && err.code === "catalog_stale",
    );
    assert.equal(persistence.publications, 3);
    assert.equal(persistence.connection.currentCatalogRevisionId, null);
  });
});

function tool(name: string): Tool {
  return {
    name,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  };
}

function connection(): McpConnectionWithServer {
  const now = new Date();
  return {
    id: "conn_lifecycle",
    userId: "user_lifecycle",
    serverId: "server_lifecycle",
    instanceKey: "default",
    label: "Lifecycle test",
    authServerIdentity: null,
    credentialId: null,
    grantedScopes: [],
    status: "disconnected",
    negotiatedProtocolVersion: null,
    serverIdentity: null,
    currentCatalogRevisionId: null,
    lastConnectedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    server: {
      canonicalResource: "mcp://test/lifecycle",
      endpointUrl: "https://mcp.example.test/mcp",
      endpointOrigin: "https://mcp.example.test",
    },
  };
}
