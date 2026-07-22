import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { inArray, like } from "drizzle-orm";

import { listMcpToolsLocal } from "../../src/modules/mcp";
import { computeDescriptorHashes } from "../../src/modules/mcp/hash";
import { insertConnection, publishCatalogRevision } from "../../src/modules/mcp/persistence";

/**
 * DB-backed offline tests for `mcp.list_tools` (PRD #540, clarification #5). The
 * reader is a bounded LOCAL read of the persisted current revision — no live
 * fetch — so these seed a connection + a published revision directly and assert
 * the ownership scope, empty/summary/detail shapes, filtering, pagination, and
 * drift flag. Opt-in on `DATABASE_URL`, mirroring the other MCP tests.
 */
const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

const ID_PREFIX = "test-mcplist-";
const createdUserIds: string[] = [];

function tool(name: string, extra?: { title?: string; description?: string }): Tool {
  return {
    name,
    ...(extra?.title ? { title: extra.title } : {}),
    ...(extra?.description ? { description: extra.description } : {}),
    inputSchema: { type: "object", additionalProperties: true },
  };
}

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  return userId;
}

async function seedConnection(userId: string): Promise<string> {
  const conn = await insertConnection({
    userId,
    label: "Test MCP",
    canonicalResource: `mcp://test/${randomUUID()}`,
    endpointUrl: "https://mcp.example.test/mcp",
    endpointOrigin: "https://mcp.example.test",
  });
  return conn.id;
}

/** Publish a revision of `tools` for a connection and return its revision hash. */
async function seedRevision(connectionId: string, tools: Tool[]): Promise<string> {
  const revisionHash = `sha256:${randomUUID().replace(/-/g, "")}`;
  await publishCatalogRevision({
    connectionId,
    revisionHash,
    descriptors: tools,
    descriptorHashes: computeDescriptorHashes(tools),
    toolCount: tools.length,
  });
  return revisionHash;
}

describe("mcp.list_tools local reader (DB-backed, offline)", { skip: SKIP }, () => {
  before(async () => {
    await db().delete(user).where(like(user.id, `${ID_PREFIX}%`));
  });

  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeConnections();
  });

  test("a connection the caller does not own reads as not_found", async () => {
    const owner = await seedUser();
    const connId = await seedConnection(owner);
    await seedRevision(connId, [tool("search")]);

    const intruder = await seedUser();
    const result = await listMcpToolsLocal({ connectionId: connId }, intruder);
    assert.equal(result.status, "not_found");
  });

  test("a missing connection reads as not_found", async () => {
    const userId = await seedUser();
    const result = await listMcpToolsLocal({ connectionId: `mcpc_${randomUUID()}` }, userId);
    assert.equal(result.status, "not_found");
  });

  test("a connection with no published revision reads as empty", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const result = await listMcpToolsLocal({ connectionId: connId }, userId);
    assert.equal(result.status, "empty");
  });

  test("returns compact summaries for the current revision", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const revision = await seedRevision(connId, [
      tool("search", { title: "Search", description: "Find things" }),
      tool("create_issue", { description: "Open a new issue" }),
    ]);

    const result = await listMcpToolsLocal({ connectionId: connId }, userId);
    assert.equal(result.status, "tools");
    if (result.status !== "tools") throw new Error("unreachable");
    assert.equal(result.catalogRevision, revision);
    assert.equal(result.toolCount, 2);
    assert.deepEqual(
      result.tools.map((summary) => summary.name).sort(),
      ["create_issue", "search"],
    );
    const search = result.tools.find((summary) => summary.name === "search");
    assert.equal(search?.title, "Search");
    assert.equal(search?.description, "Find things");
    assert.equal(result.catalogChanged, false);
  });

  test("query filters summaries by name or description", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    await seedRevision(connId, [
      tool("search", { description: "Find things" }),
      tool("create_issue", { description: "Open a ticket" }),
      tool("close_issue", { description: "Resolve a ticket" }),
    ]);

    // Matches the name of one and the description ("ticket") of two others.
    const byName = await listMcpToolsLocal({ connectionId: connId, query: "search" }, userId);
    assert.equal(byName.status === "tools" && byName.toolCount, 1);

    const byDescription = await listMcpToolsLocal(
      { connectionId: connId, query: "ticket" },
      userId,
    );
    assert.equal(byDescription.status === "tools" && byDescription.toolCount, 2);
  });

  test("paginates with limit and a next-page cursor", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const tools = Array.from({ length: 5 }, (_, index) => tool(`tool_${index}`));
    await seedRevision(connId, tools);

    const first = await listMcpToolsLocal({ connectionId: connId, limit: 2 }, userId);
    assert.equal(first.status, "tools");
    if (first.status !== "tools") throw new Error("unreachable");
    assert.equal(first.tools.length, 2);
    assert.equal(first.toolCount, 5, "toolCount is the full match count, not the page size");
    assert.ok(first.nextCursor, "more remain, so a cursor is returned");

    const second = await listMcpToolsLocal(
      { connectionId: connId, limit: 2, cursor: first.nextCursor },
      userId,
    );
    assert.equal(second.status, "tools");
    if (second.status !== "tools") throw new Error("unreachable");
    assert.equal(second.tools.length, 2);

    // The two pages are disjoint (offset advanced past the first page).
    const firstNames = new Set(first.tools.map((summary) => summary.name));
    assert.ok(second.tools.every((summary) => !firstNames.has(summary.name)));

    // The last page returns the remainder and no further cursor.
    const third = await listMcpToolsLocal(
      { connectionId: connId, limit: 2, cursor: second.nextCursor },
      userId,
    );
    assert.equal(third.status, "tools");
    if (third.status !== "tools") throw new Error("unreachable");
    assert.equal(third.tools.length, 1);
    assert.equal(third.nextCursor, undefined, "no more remain, so no cursor");
  });

  test("remoteName returns the one full descriptor; an unknown one is not_found", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    await seedRevision(connId, [tool("search", { description: "Find things" })]);

    const detail = await listMcpToolsLocal(
      { connectionId: connId, remoteName: "search" },
      userId,
    );
    assert.equal(detail.status, "tool");
    if (detail.status !== "tool") throw new Error("unreachable");
    assert.equal((detail.tool as Tool).name, "search");
    // The full descriptor is returned, not the truncated summary.
    assert.ok((detail.tool as Tool).inputSchema);

    const missing = await listMcpToolsLocal(
      { connectionId: connId, remoteName: "no_such_tool" },
      userId,
    );
    assert.equal(missing.status, "not_found");
  });

  test("catalogChanged is set when the echoed revision no longer matches", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const revision = await seedRevision(connId, [tool("search")]);

    const unchanged = await listMcpToolsLocal(
      { connectionId: connId, catalogRevision: revision },
      userId,
    );
    assert.equal(unchanged.status === "tools" && unchanged.catalogChanged, false);

    const drifted = await listMcpToolsLocal(
      { connectionId: connId, catalogRevision: "sha256:stale" },
      userId,
    );
    assert.equal(drifted.status === "tools" && drifted.catalogChanged, true);
  });
});
