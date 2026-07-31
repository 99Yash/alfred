import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import type { Tool } from "@modelcontextprotocol/client";
import { inArray, like } from "drizzle-orm";

import {
  McpRawClient,
  type McpNegotiatedServer,
  type McpProtocolCallResult,
  type McpProtocolClient,
  type McpProtocolPage,
} from "../../src/modules/mcp";
import { McpConnectionManager } from "../../src/modules/mcp/manager";
import { insertConnection, readConnection } from "../../src/modules/mcp/persistence";

/**
 * DB-backed tests for the connection manager (PRD #540). A real `McpRawClient`
 * is wired to a FAKE `McpProtocolClient` through the raw client's
 * `protocolFactory`, injected via the manager's `clientFactory` seam — so
 * connect → refresh → publish → status runs end-to-end with no socket. Opt-in on
 * `DATABASE_URL`, mirroring the other MCP tests.
 */
const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

const ID_PREFIX = "test-mcpmgr-";
const createdUserIds: string[] = [];

class FakeProtocol implements McpProtocolClient {
  tools: Tool[];
  callResult: McpProtocolCallResult = { content: [{ type: "text", text: "ok" }] };
  negotiated: McpNegotiatedServer = {
    protocolEra: "pre_2026_07_28",
    protocolVersion: "2025-11-25",
    serverName: "fake",
    serverVersion: "1",
    hasTools: true,
    toolsListChanged: true,
  };

  /** Set to reject `connect()` — exercises the manager's failure branch. */
  connectError: Error | null = null;
  #toolsChanged: (() => void | Promise<void>) | null = null;

  constructor(tools: Tool[]) {
    this.tools = tools;
  }

  async connect(): Promise<McpNegotiatedServer> {
    if (this.connectError) throw this.connectError;
    return this.negotiated;
  }
  async close(): Promise<void> {}
  async listTools(): Promise<McpProtocolPage> {
    return { tools: this.tools };
  }
  async callTool(): Promise<McpProtocolCallResult> {
    return this.callResult;
  }
  onToolsChanged(handler: () => void | Promise<void>): void {
    this.#toolsChanged = handler;
  }
  onConnectionUnhealthy(): void {}
  async emitToolsChanged(): Promise<void> {
    await this.#toolsChanged?.();
  }
}

function tool(name: string): Tool {
  return {
    name,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  };
}

async function seedConnection(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  const conn = await insertConnection({
    userId,
    label: "Test MCP",
    canonicalResource: `mcp://test/${randomUUID()}`,
    endpointUrl: "https://mcp.example.test/mcp",
    endpointOrigin: "https://mcp.example.test",
  });
  return conn.id;
}

function managerWith(protocol: FakeProtocol): McpConnectionManager {
  return new McpConnectionManager({
    clientFactory: (connection) =>
      new McpRawClient({
        connectionId: connection.id,
        endpoint: new URL(connection.endpointUrl),
        endpointAuthorization: { authorize: async (endpoint) => new URL(endpoint.href) },
        protocolFactory: () => protocol,
      }),
  });
}

describe("mcp connection manager (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
  });

  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeConnections();
  });

  test("getReadyClient connects, publishes the catalog, and marks ready", async () => {
    const connId = await seedConnection();
    const protocol = new FakeProtocol([tool("tool_a")]);
    const manager = managerWith(protocol);

    const client = await manager.getReadyClient(connId);
    assert.ok(client.catalog);

    const row = await readConnection(connId);
    assert.equal(row?.status, "ready");
    assert.equal(row?.negotiatedProtocolVersion, "2025-11-25");
    assert.ok(row?.currentCatalogRevisionId);
    assert.ok(row?.lastConnectedAt);
  });

  test("refreshCatalog is idempotent then advances on a catalog change", async () => {
    const connId = await seedConnection();
    const protocol = new FakeProtocol([tool("tool_a")]);
    const manager = managerWith(protocol);

    await manager.getReadyClient(connId);
    const firstRevisionId = (await readConnection(connId))?.currentCatalogRevisionId;

    // Same tools → same published revision, pointer unchanged.
    await manager.refreshCatalog(connId);
    assert.equal((await readConnection(connId))?.currentCatalogRevisionId, firstRevisionId);

    // A changed catalog mints a new revision and advances the pointer.
    protocol.tools = [tool("tool_a"), tool("tool_b")];
    const snapshot = await manager.refreshCatalog(connId);
    assert.equal(snapshot.tools.length, 2);
    assert.notEqual((await readConnection(connId))?.currentCatalogRevisionId, firstRevisionId);
  });

  test("list_changed clears and replaces the durable catalog revision", async () => {
    const connId = await seedConnection();
    const protocol = new FakeProtocol([tool("tool_a")]);
    const manager = managerWith(protocol);

    await manager.getReadyClient(connId);
    const first = await readConnection(connId);
    assert.ok(first?.currentCatalogRevisionId);

    protocol.tools = [tool("tool_b")];
    await protocol.emitToolsChanged();
    await manager.getReadyClient(connId);

    const second = await readConnection(connId);
    assert.equal(second?.status, "ready");
    assert.ok(second?.currentCatalogRevisionId);
    assert.notEqual(second?.currentCatalogRevisionId, first.currentCatalogRevisionId);
  });

  test("callTool routes through the ready client against the live revision", async () => {
    const connId = await seedConnection();
    const protocol = new FakeProtocol([tool("tool_a")]);
    const manager = managerWith(protocol);

    const client = await manager.getReadyClient(connId);
    const revision = client.catalog?.revision;
    assert.ok(revision);

    const envelope = await manager.callTool(
      { kind: "mcp", connectionId: connId, remoteName: "tool_a", catalogRevision: revision },
      {},
    );
    assert.equal(envelope.outcome, "completed");
    assert.equal(envelope.toolName, "tool_a");
  });

  test("a failed connect records a BOUNDED, REDACTED lastError", async () => {
    const connId = await seedConnection();
    // The shape the real SDK throws: `StreamableHTTPError` inlines the ENTIRE
    // upstream response body into its message (streamableHttp.js — `Error POSTing
    // to endpoint: ${text}`). An MCP server is the least trusted counterparty
    // Alfred talks to, so this column must never take the body verbatim.
    const secret = "sk-live-abcdef0123456789";
    const protocol = new FakeProtocol([tool("tool_a")]);
    protocol.connectError = new Error(
      `Error POSTing to endpoint: {"authorization":"Bearer ${secret}","detail":"${"x".repeat(2_000)}"}`,
    );
    const manager = managerWith(protocol);

    await assert.rejects(() => manager.getReadyClient(connId));

    const row = await readConnection(connId);
    assert.equal(row?.status, "failed");
    const lastError = row?.lastError ?? "";
    assert.ok(!lastError.includes(secret), "the upstream body's token must not be persisted");
    assert.match(lastError, /\[\+\d+ chars\]$/, "an over-long body must read as clipped");
    assert.ok(lastError.length < 600, `lastError should be bounded, got ${lastError.length}`);
  });

  test("disconnect closes the client and marks the row disconnected", async () => {
    const connId = await seedConnection();
    const manager = managerWith(new FakeProtocol([tool("tool_a")]));

    await manager.getReadyClient(connId);
    await manager.disconnect(connId);
    assert.equal((await readConnection(connId))?.status, "disconnected");
  });
});
