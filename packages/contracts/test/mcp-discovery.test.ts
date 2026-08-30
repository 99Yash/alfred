import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  MCP_LIST_TOOLS_MAX_LIMIT,
  mcpCallInput,
  mcpExternalToolRefSchema,
  mcpListToolsInput,
  mcpToolDiscoveryPageSchema,
  mcpToolInspectionResultSchema,
  parseMcpListToolsOperation,
} from "@alfred/contracts";

const ref = {
  kind: "mcp" as const,
  connectionId: "connection-1",
  remoteName: "calendar.create_event",
  catalogRevision: "revision-1",
};

const connection = {
  id: "connection-1",
  instanceKey: "work",
  label: "Work calendar",
};

const hit = {
  ref,
  namespace: "server-1",
  connection,
  title: "Create event",
  description: "Create one calendar event.",
};

describe("MCP discovery contracts", () => {
  test("accepts one exact external tool reference and derives the call envelope from it", () => {
    assert.deepEqual(mcpExternalToolRefSchema.parse(ref), ref);
    assert.equal(mcpExternalToolRefSchema.safeParse({ ...ref, extra: true }).success, false);

    assert.deepEqual(
      mcpCallInput.parse({
        connectionId: ref.connectionId,
        remoteName: ref.remoteName,
        catalogRevision: ref.catalogRevision,
        arguments: { calendarId: "primary" },
      }),
      {
        connectionId: ref.connectionId,
        remoteName: ref.remoteName,
        catalogRevision: ref.catalogRevision,
        arguments: { calendarId: "primary" },
      },
    );
    assert.equal(mcpCallInput.safeParse({ ...ref, arguments: {} }).success, false);
  });

  test("accepts an empty search", () => {
    assert.deepEqual(mcpListToolsInput.parse({}), {});
  });

  test("rejects mixed search and inspection fields", () => {
    assert.equal(mcpListToolsInput.safeParse({ ref, query: "calendar" }).success, false);
    assert.equal(mcpListToolsInput.safeParse({ ref, limit: 1 }).success, false);
    assert.equal(mcpListToolsInput.safeParse({ ref, query: undefined }).success, false);
    assert.equal(
      mcpListToolsInput.safeParse({ connectionId: "connection-1", remoteName: "tool" }).success,
      false,
    );
  });

  test("parses one search-or-inspect operation at the contract boundary", () => {
    assert.deepEqual(parseMcpListToolsOperation({ query: "calendar", limit: 2 }), {
      operation: "search",
      input: { query: "calendar", limit: 2 },
    });
    assert.deepEqual(parseMcpListToolsOperation({ ref }), {
      operation: "inspect",
      input: { ref },
    });
    assert.throws(() => parseMcpListToolsOperation({ ref, query: "calendar" }));
  });

  test("accepts only the exact-ref inspection form", () => {
    assert.deepEqual(mcpListToolsInput.parse({ ref }), { ref });
    assert.equal(mcpListToolsInput.safeParse({ ref: { ...ref, extra: true } }).success, false);
    assert.equal(
      mcpListToolsInput.safeParse({
        ref: { connectionId: ref.connectionId, remoteName: ref.remoteName },
      }).success,
      false,
    );
  });

  test("enforces search input bounds", () => {
    assert.equal(mcpListToolsInput.safeParse({ query: "q".repeat(200) }).success, true);
    assert.equal(mcpListToolsInput.safeParse({ query: "q".repeat(201) }).success, false);
    assert.equal(mcpListToolsInput.safeParse({ cursor: "c".repeat(512) }).success, true);
    assert.equal(mcpListToolsInput.safeParse({ cursor: "c".repeat(513) }).success, false);
    assert.equal(mcpListToolsInput.safeParse({ limit: MCP_LIST_TOOLS_MAX_LIMIT }).success, true);
    assert.equal(
      mcpListToolsInput.safeParse({ limit: MCP_LIST_TOOLS_MAX_LIMIT + 1 }).success,
      false,
    );
    assert.equal(mcpListToolsInput.safeParse({ limit: 0 }).success, false);
  });

  test("bounds strict discovery pages", () => {
    assert.deepEqual(
      mcpToolDiscoveryPageSchema.parse({ status: "tools", tools: [hit], nextCursor: null }),
      { status: "tools", tools: [hit], nextCursor: null },
    );
    assert.equal(
      mcpToolDiscoveryPageSchema.safeParse({
        status: "tools",
        tools: Array.from({ length: MCP_LIST_TOOLS_MAX_LIMIT + 1 }, () => hit),
        nextCursor: null,
      }).success,
      false,
    );
    assert.equal(
      mcpToolDiscoveryPageSchema.safeParse({
        status: "tools",
        tools: [{ ...hit, name: ref.remoteName }],
        nextCursor: null,
      }).success,
      false,
    );
    assert.equal(
      mcpToolDiscoveryPageSchema.safeParse({ status: "tools", tools: [], nextCursor: "" }).success,
      false,
    );
    assert.equal(
      mcpToolDiscoveryPageSchema.safeParse({
        status: "tools",
        tools: [{ ...hit, connection: { ...connection, id: "connection-2" } }],
        nextCursor: null,
      }).success,
      false,
    );
  });

  test("accepts bounded full-tool inspection results and strict negative results", () => {
    assert.deepEqual(
      mcpToolInspectionResultSchema.parse({
        status: "tool",
        ref,
        connection,
        tool: {
          name: ref.remoteName,
          inputSchema: { type: "object", properties: { title: { type: "string" } } },
        },
      }),
      {
        status: "tool",
        ref,
        connection,
        tool: {
          name: ref.remoteName,
          inputSchema: { type: "object", properties: { title: { type: "string" } } },
        },
      },
    );
    assert.equal(
      mcpToolInspectionResultSchema.safeParse({
        status: "tool",
        ref,
        connection: { ...connection, id: "connection-2" },
        tool: { name: ref.remoteName, inputSchema: { type: "object" } },
      }).success,
      false,
    );

    for (const status of ["not_found", "catalog_stale"] as const) {
      assert.equal(
        mcpToolInspectionResultSchema.safeParse({ status, ref, message: "Unavailable." }).success,
        true,
      );
      assert.equal(
        mcpToolInspectionResultSchema.safeParse({
          status,
          ref,
          message: "Unavailable.",
          catalogRevision: "other-revision",
        }).success,
        false,
      );
    }
  });
});
