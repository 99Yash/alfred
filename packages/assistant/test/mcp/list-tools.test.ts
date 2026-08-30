import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { isApiError, type ExternalToolRef } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import type { Tool } from "@modelcontextprotocol/client";
import { inArray, like } from "drizzle-orm";

import { inspectMcpToolLocal, searchMcpToolsLocal } from "../../src/connections/mcp";
import { computeDescriptorHashes } from "../../src/connections/mcp/hash";
import {
  createNamedConnection,
  publishCatalogRevision,
} from "../../src/connections/mcp/persistence";
import { dbBackedSkip } from "../support/db-backed";

/** DB-backed offline tests for bounded cross-connection MCP discovery. */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-mcpdiscover-";
const createdUserIds: string[] = [];

interface SeededConnection {
  id: string;
  instanceKey: string;
  namespace: string;
}

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

async function seedConnection(
  userId: string,
  input: { label: string; resource?: string },
): Promise<SeededConnection> {
  const identity = input.resource ?? randomUUID();
  const connection = await createNamedConnection({
    userId,
    label: input.label,
    canonicalResource: `mcp://test/${identity}`,
    endpoint: new URL(`https://${identity}.mcp.example.test/mcp`),
  });
  return {
    id: connection.id,
    instanceKey: connection.instanceKey,
    namespace: connection.serverId,
  };
}

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

function assertBadCursor(error: unknown): boolean {
  assert.ok(isApiError(error, "BAD_REQUEST"));
  assert.match(error.message, /cursor/i);
  return true;
}

describe("cross-connection MCP discovery (DB-backed, offline)", { skip: SKIP }, () => {
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

  test("unfiltered search returns two owned catalogs and excludes a foreign catalog", async () => {
    const owner = await seedUser();
    const first = await seedConnection(owner, { label: "Primary issues" });
    const second = await seedConnection(owner, { label: "Archive issues" });
    const firstRevision = await seedRevision(first.id, [tool("search")]);
    const secondRevision = await seedRevision(second.id, [tool("search")]);

    const foreignOwner = await seedUser();
    const foreign = await seedConnection(foreignOwner, { label: "Foreign issues" });
    await seedRevision(foreign.id, [tool("search")]);

    const result = await searchMcpToolsLocal({ userId: owner });
    assert.equal(result.status, "tools");
    assert.equal(result.tools.length, 2);
    assert.equal(result.nextCursor, null);
    assert.deepEqual(
      new Set(result.tools.map((hit) => hit.ref.connectionId)),
      new Set([first.id, second.id]),
    );
    assert.deepEqual(
      new Set(result.tools.map((hit) => hit.namespace)),
      new Set([first.namespace, second.namespace]),
    );
    assert.deepEqual(
      new Set(result.tools.map((hit) => hit.ref.catalogRevision)),
      new Set([firstRevision, secondRevision]),
    );
    assert.ok(result.tools.every((hit) => hit.ref.kind === "mcp"));
    assert.ok(result.tools.every((hit) => hit.ref.remoteName === "search"));
    assert.deepEqual(
      new Set(result.tools.map((hit) => hit.connection.instanceKey)),
      new Set([first.instanceKey, second.instanceKey]),
    );
    assert.ok(
      result.tools.every((hit) => hit.ref.connectionId !== foreign.id),
      "foreign connections do not enter the scan",
    );
  });

  test("duplicate remote names remain distinct exact refs across connection instances", async () => {
    const userId = await seedUser();
    const resource = randomUUID();
    const first = await seedConnection(userId, { label: "Work", resource });
    const second = await seedConnection(userId, { label: "Personal", resource });
    await seedRevision(first.id, [tool("create_issue")]);
    await seedRevision(second.id, [tool("create_issue")]);

    const result = await searchMcpToolsLocal({ userId, query: "create_issue" });
    assert.equal(result.tools.length, 2);
    assert.equal(result.tools[0]?.namespace, result.tools[1]?.namespace);
    assert.notEqual(result.tools[0]?.ref.connectionId, result.tools[1]?.ref.connectionId);
    assert.notEqual(
      result.tools[0]?.connection.instanceKey,
      result.tools[1]?.connection.instanceKey,
    );
    assert.notDeepEqual(result.tools[0]?.ref, result.tools[1]?.ref);
  });

  test("namespace and connection filters are exact, owner-scoped, and combine with AND", async () => {
    const userId = await seedUser();
    const first = await seedConnection(userId, { label: "First" });
    const second = await seedConnection(userId, { label: "Second" });
    await seedRevision(first.id, [tool("first_tool")]);
    await seedRevision(second.id, [tool("second_tool")]);

    const byNamespace = await searchMcpToolsLocal({ userId, namespace: first.namespace });
    assert.deepEqual(
      byNamespace.tools.map((hit) => hit.ref.connectionId),
      [first.id],
    );
    const byConnection = await searchMcpToolsLocal({ userId, connectionId: second.id });
    assert.deepEqual(
      byConnection.tools.map((hit) => hit.ref.connectionId),
      [second.id],
    );
    const exactPair = await searchMcpToolsLocal({
      userId,
      namespace: first.namespace,
      connectionId: first.id,
    });
    assert.deepEqual(
      exactPair.tools.map((hit) => hit.ref.connectionId),
      [first.id],
    );
    const mismatchedPair = await searchMcpToolsLocal({
      userId,
      namespace: first.namespace,
      connectionId: second.id,
    });
    assert.deepEqual(mismatchedPair, { status: "tools", tools: [], nextCursor: null });

    const intruder = await seedUser();
    const foreignFilter = await searchMcpToolsLocal({
      userId: intruder,
      namespace: first.namespace,
      connectionId: first.id,
    });
    assert.deepEqual(foreignFilter, { status: "tools", tools: [], nextCursor: null });
  });

  test("lexical search covers label, remote name, title, and visible description", async () => {
    const userId = await seedUser();
    const connection = await seedConnection(userId, { label: "Roadmap workspace" });
    await seedRevision(connection.id, [
      tool("lookup_records", { title: "Find milestones", description: "Search the public index" }),
      tool("open_ticket", { title: "Create item", description: "Escalate a customer incident" }),
    ]);

    const cases = [
      ["roadmap", ["lookup_records", "open_ticket"]],
      ["lookup", ["lookup_records"]],
      ["milestones", ["lookup_records"]],
      ["customer incident", ["open_ticket"]],
    ] as const;
    for (const [query, expectedNames] of cases) {
      const page = await searchMcpToolsLocal({ userId, query });
      assert.deepEqual(
        page.tools.map((hit) => hit.ref.remoteName),
        expectedNames,
        `query '${query}' matches the expected visible field`,
      );
    }
  });

  test("detail:names keeps exact identity and removes only prose", async () => {
    const userId = await seedUser();
    const connection = await seedConnection(userId, { label: "Issue tracker" });
    const revision = await seedRevision(connection.id, [
      tool("create_issue", { title: "Create", description: "Open a ticket" }),
    ]);
    const result = await searchMcpToolsLocal({ userId, query: "ticket", detail: "names" });
    assert.equal(result.tools.length, 1, "filtering uses prose before the names projection");
    assert.deepEqual(result.tools[0], {
      ref: {
        kind: "mcp",
        connectionId: connection.id,
        remoteName: "create_issue",
        catalogRevision: revision,
      },
      namespace: connection.namespace,
      connection: {
        id: connection.id,
        instanceKey: connection.instanceKey,
        label: "Issue tracker",
      },
    });
  });

  test("response pagination traverses every matching exact ref once", async () => {
    const userId = await seedUser();
    const connections = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        seedConnection(userId, { label: `Connection ${index}` }),
      ),
    );
    for (const [index, connection] of connections.entries()) {
      await seedRevision(
        connection.id,
        Array.from({ length: 3 }, (_, toolIndex) => tool(`match_${index}_${toolIndex}`)),
      );
    }

    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await searchMcpToolsLocal({ userId, query: "match", limit: 2, cursor });
      assert.ok(page.tools.length <= 2);
      for (const hit of page.tools) {
        const key = JSON.stringify(hit.ref);
        assert.equal(seen.has(key), false, `duplicate traversal ref ${key}`);
        seen.add(key);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(seen.size, 15);
  });

  test("catalog and descriptor scan batches advance through a zero-match page", async () => {
    const userId = await seedUser();
    const connections = await Promise.all(
      Array.from({ length: 5 }, (_, index) => seedConnection(userId, { label: `Batch ${index}` })),
    );
    const ordered = [...connections].sort((left, right) =>
      left.namespace < right.namespace ? -1 : left.namespace > right.namespace ? 1 : 0,
    );
    for (const [index, connection] of ordered.entries()) {
      await seedRevision(connection.id, [tool(index === 4 ? "target_catalog" : `other_${index}`)]);
    }

    const firstCatalogBatch = await searchMcpToolsLocal({ userId, query: "target_catalog" });
    assert.deepEqual(firstCatalogBatch.tools, []);
    assert.ok(firstCatalogBatch.nextCursor, "unscanned catalogs require a cursor");
    const secondCatalogBatch = await searchMcpToolsLocal({
      userId,
      query: "target_catalog",
      cursor: firstCatalogBatch.nextCursor ?? undefined,
    });
    assert.deepEqual(
      secondCatalogBatch.tools.map((hit) => hit.ref.remoteName),
      ["target_catalog"],
    );

    const descriptorConnection = await seedConnection(userId, { label: "Large catalog" });
    await seedRevision(descriptorConnection.id, [
      ...Array.from({ length: 200 }, (_, index) =>
        tool(`a_other_${String(index).padStart(3, "0")}`),
      ),
      tool("z_target_descriptor"),
    ]);
    const firstDescriptorBatch = await searchMcpToolsLocal({
      userId,
      connectionId: descriptorConnection.id,
      query: "target_descriptor",
    });
    assert.deepEqual(firstDescriptorBatch.tools, []);
    assert.ok(firstDescriptorBatch.nextCursor, "unscanned descriptors require a cursor");
    const secondDescriptorBatch = await searchMcpToolsLocal({
      userId,
      connectionId: descriptorConnection.id,
      query: "target_descriptor",
      cursor: firstDescriptorBatch.nextCursor ?? undefined,
    });
    assert.deepEqual(
      secondDescriptorBatch.tools.map((hit) => hit.ref.remoteName),
      ["z_target_descriptor"],
    );
  });

  test("malformed, filter-mismatched, and stale-revision cursors fail visibly", async () => {
    const userId = await seedUser();
    const connection = await seedConnection(userId, { label: "Cursor catalog" });
    await seedRevision(connection.id, [tool("first"), tool("second")]);

    await assert.rejects(
      () => searchMcpToolsLocal({ userId, cursor: "not-an-opaque-cursor" }),
      assertBadCursor,
    );
    const page = await searchMcpToolsLocal({ userId, connectionId: connection.id, limit: 1 });
    assert.ok(page.nextCursor);
    await assert.rejects(
      () =>
        searchMcpToolsLocal({
          userId,
          connectionId: connection.id,
          query: "different-filter",
          limit: 1,
          cursor: page.nextCursor ?? undefined,
        }),
      assertBadCursor,
    );

    await seedRevision(connection.id, [tool("replacement")]);
    await assert.rejects(
      () =>
        searchMcpToolsLocal({
          userId,
          connectionId: connection.id,
          limit: 1,
          cursor: page.nextCursor ?? undefined,
        }),
      assertBadCursor,
    );
  });

  test("exact inspection returns one owned descriptor and detects ownership and drift", async () => {
    const userId = await seedUser();
    const connection = await seedConnection(userId, { label: "Inspect catalog" });
    await seedRevision(connection.id, [tool("search", { description: "Find records" })]);
    const page = await searchMcpToolsLocal({ userId, connectionId: connection.id });
    const ref = page.tools[0]?.ref;
    assert.ok(ref);

    const inspected = await inspectMcpToolLocal({ userId, ref });
    assert.equal(inspected.status, "tool");
    if (inspected.status !== "tool") throw new Error("unreachable");
    assert.deepEqual(inspected.ref, ref);
    assert.deepEqual(inspected.connection, {
      id: connection.id,
      instanceKey: connection.instanceKey,
      label: "Inspect catalog",
    });
    assert.equal(inspected.tool.name, "search");
    assert.ok(inspected.tool.inputSchema, "inspection returns the one full descriptor");

    const intruder = await seedUser();
    const unowned = await inspectMcpToolLocal({ userId: intruder, ref });
    assert.equal(unowned.status, "not_found");
    assert.deepEqual(unowned.ref, ref);

    await seedRevision(connection.id, [tool("search"), tool("new_tool")]);
    const stale = await inspectMcpToolLocal({ userId, ref });
    assert.equal(stale.status, "catalog_stale");
    assert.deepEqual(stale.ref, ref);
  });

  test("inspection requires the exact remote name from the selected current ref", async () => {
    const userId = await seedUser();
    const connection = await seedConnection(userId, { label: "Exact catalog" });
    const revision = await seedRevision(connection.id, [tool("known")]);
    const missingRef: ExternalToolRef = {
      kind: "mcp",
      connectionId: connection.id,
      remoteName: "missing",
      catalogRevision: revision,
    };

    const result = await inspectMcpToolLocal({ userId, ref: missingRef });
    assert.equal(result.status, "not_found");
    assert.deepEqual(result.ref, missingRef);
  });
});
