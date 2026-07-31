import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { McpConnection } from "@alfred/db/schemas";
import type { Tool } from "@modelcontextprotocol/client";

import {
  McpClientError,
  McpRawClient,
  type McpNegotiatedServer,
  type McpProtocolCallResult,
  type McpProtocolClient,
  type McpProtocolPage,
} from "../../src/modules/mcp";
import {
  McpConnectionManager,
  type McpConnectionManagerPersistence,
} from "../../src/modules/mcp/manager";

class FakeProtocol implements McpProtocolClient {
  tools: Tool[] = [tool("tool_a")];
  connectCount = 0;
  onListTools: (() => void | Promise<void>) | null = null;
  #toolsChanged: (() => void | Promise<void>) | null = null;

  async connect(): Promise<McpNegotiatedServer> {
    this.connectCount += 1;
    return {
      protocolEra: "pre_2026_07_28",
      protocolVersion: "2025-11-25",
      serverName: "fake",
      serverVersion: "1",
      hasTools: true,
      toolsListChanged: true,
    };
  }

  async close(): Promise<void> {}

  async listTools(): Promise<McpProtocolPage> {
    await this.onListTools?.();
    return { tools: this.tools, ttlMs: 0, cacheScope: "private" };
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
  publications = 0;
  onPublish: (() => void | Promise<void>) | null = null;

  readConnection: McpConnectionManagerPersistence["readConnection"] = async (id) =>
    id === this.connection.id ? this.connection : undefined;

  updateConnection: McpConnectionManagerPersistence["updateConnection"] = async (id, patch) => {
    if (id !== this.connection.id) return undefined;
    Object.assign(this.connection, patch, { updatedAt: new Date() });
    return this.connection;
  };

  insertCatalogRevision: McpConnectionManagerPersistence["insertCatalogRevision"] = async (
    input,
  ) => {
    this.publications += 1;
    await this.onPublish?.();
    const now = new Date();
    return {
      id: `revision-${this.publications}`,
      connectionId: input.connectionId,
      revisionHash: input.revisionHash,
      descriptors: input.descriptors,
      descriptorHashes: input.descriptorHashes,
      toolCount: input.toolCount,
      createdAt: now,
      updatedAt: now,
    };
  };
}

function managerWith(protocol: FakeProtocol, persistence: MemoryPersistence): McpConnectionManager {
  return new McpConnectionManager({
    persistence,
    clientFactory: (row) =>
      new McpRawClient({
        connectionId: row.id,
        endpoint: new URL(row.endpointUrl),
        endpointAuthorization: { authorize: async (endpoint) => new URL(endpoint.href) },
        protocolFactory: () => protocol,
      }),
  });
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

function connection(): McpConnection {
  const now = new Date();
  return {
    id: "conn_lifecycle",
    userId: "user_lifecycle",
    label: "Lifecycle test",
    canonicalResource: "mcp://test/lifecycle",
    endpointUrl: "https://mcp.example.test/mcp",
    endpointOrigin: "https://mcp.example.test",
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
  };
}
