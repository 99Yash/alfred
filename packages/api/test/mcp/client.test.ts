import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  McpClientError,
  McpRawClient,
  type McpProtocolCallResult,
  type McpProtocolClient,
  type McpProtocolPage,
  type McpNegotiatedServer,
} from "../../src/modules/mcp";

class FakeProtocol implements McpProtocolClient {
  readonly pages: McpProtocolPage[];
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  connected = false;
  closedWithTerminate: boolean | null = null;
  callResult: McpProtocolCallResult = { content: [{ type: "text", text: "ok" }] };
  connectError: Error | null = null;
  negotiated: McpNegotiatedServer = {
    protocolVersion: "2025-11-25",
    serverName: "fake",
    serverVersion: "1",
    hasTools: true,
    toolsListChanged: true,
  };
  callError: Error | null = null;
  listHook: (() => void | Promise<void>) | null = null;
  #toolsChanged: (() => void | Promise<void>) | null = null;

  constructor(pages: McpProtocolPage[]) {
    this.pages = pages;
  }

  async connect(): Promise<McpNegotiatedServer> {
    if (this.connectError) throw this.connectError;
    this.connected = true;
    return this.negotiated;
  }

  async close(terminateSession: boolean): Promise<void> {
    this.closedWithTerminate = terminateSession;
  }

  async listTools(cursor: string | undefined): Promise<McpProtocolPage> {
    await this.listHook?.();
    const index = cursor ? Number(cursor) : 0;
    const page = this.pages[index];
    if (!page) return { tools: [] };
    return page;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpProtocolCallResult> {
    if (this.callError) throw this.callError;
    this.calls.push({ name, args });
    return this.callResult;
  }

  onToolsChanged(handler: () => void | Promise<void>): void {
    this.#toolsChanged = handler;
  }

  async emitToolsChanged(): Promise<void> {
    await this.#toolsChanged?.();
  }
}

function tool(name: string, inputSchema: Tool["inputSchema"], extra: Partial<Tool> = {}): Tool {
  return { name, inputSchema, ...extra };
}

const SEARCH_TOOL = tool("search", {
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
  additionalProperties: false,
});

function makeClient(
  protocol: FakeProtocol,
  overrides: Partial<ConstructorParameters<typeof McpRawClient>[0]> = {},
) {
  return new McpRawClient({
    connectionId: "conn_1",
    endpoint: new URL("https://mcp.example.test/mcp"),
    endpointAuthorization: {
      authorize: async (endpoint) => new URL(endpoint.href),
    },
    protocolFactory: () => protocol,
    ...overrides,
  });
}

async function assertMcpError(
  promise: Promise<unknown>,
  code: McpClientError["code"],
): Promise<void> {
  await assert.rejects(
    promise,
    (err: unknown) => err instanceof McpClientError && err.code === code,
  );
}

describe("McpRawClient catalog", () => {
  test("authorizes the endpoint before creating or connecting the protocol", async () => {
    const events: string[] = [];
    const protocol = new FakeProtocol([{ tools: [] }]);
    const client = makeClient(protocol, {
      endpointAuthorization: {
        authorize: async (endpoint) => {
          events.push(`authorize:${endpoint.href}`);
          return new URL(endpoint.href);
        },
      },
      protocolFactory: () => {
        events.push("factory");
        return protocol;
      },
    });

    await client.connect();

    assert.deepEqual(events, ["authorize:https://mcp.example.test/mcp", "factory"]);
    assert.equal(protocol.connected, true);
  });

  test("closes a partially-started protocol when connect fails", async () => {
    const protocol = new FakeProtocol([{ tools: [] }]);
    protocol.connectError = new Error("handshake failed");
    const client = makeClient(protocol);

    await assert.rejects(client.connect(), /handshake failed/);

    assert.equal(protocol.closedWithTerminate, false);
    await assertMcpError(client.refreshCatalog(), "not_connected");
  });

  test("requires the v1 protocol and a server tools capability", async () => {
    const oldProtocol = new FakeProtocol([{ tools: [] }]);
    oldProtocol.negotiated.protocolVersion = "2025-06-18";
    const oldClient = makeClient(oldProtocol);
    await assertMcpError(oldClient.connect(), "unsupported_protocol_version");
    assert.equal(oldProtocol.closedWithTerminate, false);

    const noTools = new FakeProtocol([{ tools: [] }]);
    noTools.negotiated.hasTools = false;
    const noToolsClient = makeClient(noTools);
    await assertMcpError(noToolsClient.connect(), "missing_tools_capability");
    assert.equal(noTools.closedWithTerminate, false);
  });

  test("paginates, sorts tools, and produces a stable content revision", async () => {
    const alpha = tool("alpha", { type: "object", properties: {} });
    const beta = tool("beta", { properties: {}, type: "object" });
    const protocol = new FakeProtocol([{ tools: [beta], nextCursor: "1" }, { tools: [alpha] }]);
    const client = makeClient(protocol);
    await client.connect();

    const first = await client.refreshCatalog();
    assert.deepEqual(
      first.tools.map((entry) => entry.name),
      ["alpha", "beta"],
    );
    assert.match(first.revision, /^sha256:[a-f0-9]{64}$/);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.tools), true);
    assert.equal(Object.isFrozen(first.tools[0]?.inputSchema), true);

    const second = await client.refreshCatalog();
    assert.equal(second.revision, first.revision, "same descriptors must keep the same authority");
  });

  test("fails closed on duplicate names and pagination loops", async () => {
    const duplicate = new FakeProtocol([{ tools: [SEARCH_TOOL, SEARCH_TOOL] }]);
    const duplicateClient = makeClient(duplicate);
    await duplicateClient.connect();
    await assertMcpError(duplicateClient.refreshCatalog(), "duplicate_tool");

    const looping = new FakeProtocol([{ tools: [], nextCursor: "0" }]);
    const loopingClient = makeClient(looping);
    await loopingClient.connect();
    await assertMcpError(loopingClient.refreshCatalog(), "catalog_limit");
  });

  test("rejects unsafe names and schemas before compiling the catalog", async () => {
    const badName = new FakeProtocol([
      { tools: [tool("bad\u0000name", { type: "object", properties: {} })] },
    ]);
    const badNameClient = makeClient(badName);
    await badNameClient.connect();
    await assertMcpError(badNameClient.refreshCatalog(), "invalid_schema");

    const externalRef = new FakeProtocol([
      {
        tools: [
          tool("external_ref", {
            type: "object",
            properties: { payload: { $ref: "https://schemas.example.test/payload.json" } },
          }),
        ],
      },
    ]);
    const externalRefClient = makeClient(externalRef);
    await externalRefClient.connect();
    await assertMcpError(externalRefClient.refreshCatalog(), "invalid_schema");
  });

  test("refuses $id/$anchor so a server cannot poison the shared validator cache", async () => {
    // Ajv caches compiled validators by `$id`. A permissive schema registered
    // under `$id: "x"` would otherwise be returned for any later tool reusing
    // that `$id`, validating strict tools against the lenient cached schema and
    // bypassing the exact-schema gate. Both tools declare the same `$id`, so the
    // catalog must fail closed before either schema is compiled.
    const idCollision = new FakeProtocol([
      {
        tools: [
          tool("read_note", {
            $id: "x",
            type: "object",
            properties: {},
            additionalProperties: true,
          } as Tool["inputSchema"]),
          tool("delete_repo", {
            $id: "x",
            type: "object",
            properties: { confirm: { const: true } },
            required: ["confirm"],
            additionalProperties: false,
          } as Tool["inputSchema"]),
        ],
      },
    ]);
    const idClient = makeClient(idCollision);
    await idClient.connect();
    await assertMcpError(idClient.refreshCatalog(), "invalid_schema");
    assert.equal(idClient.catalog, null);

    const anchored = new FakeProtocol([
      {
        tools: [
          tool("anchored", {
            type: "object",
            properties: { field: { $anchor: "a", type: "string" } },
          } as Tool["inputSchema"]),
        ],
      },
    ]);
    const anchoredClient = makeClient(anchored);
    await anchoredClient.connect();
    await assertMcpError(anchoredClient.refreshCatalog(), "invalid_schema");
  });

  test("orders tools by code point, not locale collation, for a portable revision", async () => {
    // `localeCompare` is ICU/locale-dependent; code-point order is not. Names
    // that collate ambiguously across locales ("Z" vs "a") must produce a fixed
    // array order so the revision hash is stable across hosts.
    const upperZ = tool("Zebra", { type: "object", properties: {} });
    const lowerA = tool("apple", { type: "object", properties: {} });
    const protocol = new FakeProtocol([{ tools: [lowerA, upperZ] }]);
    const client = makeClient(protocol);
    await client.connect();

    const catalog = await client.refreshCatalog();
    assert.deepEqual(
      catalog.tools.map((entry) => entry.name),
      ["Zebra", "apple"],
      "uppercase 'Z' (U+005A) must sort before lowercase 'a' (U+0061)",
    );
  });

  test("a list_changed notification invalidates authority until refresh", async () => {
    const protocol = new FakeProtocol([{ tools: [SEARCH_TOOL] }]);
    const client = makeClient(protocol);
    await client.connect();
    const catalog = await client.refreshCatalog();
    await protocol.emitToolsChanged();

    assert.equal(client.catalog, null);
    await assertMcpError(
      client.callTool(
        {
          kind: "mcp",
          connectionId: "conn_1",
          remoteName: "search",
          catalogRevision: catalog.revision,
        },
        { query: "hello" },
      ),
      "catalog_required",
    );
    assert.equal(protocol.calls.length, 0);
  });

  test("does not commit a snapshot invalidated during pagination", async () => {
    const protocol = new FakeProtocol([{ tools: [SEARCH_TOOL] }]);
    const client = makeClient(protocol);
    await client.connect();
    protocol.listHook = async () => protocol.emitToolsChanged();

    await assertMcpError(client.refreshCatalog(), "catalog_stale");

    assert.equal(client.catalog, null);
  });
});

describe("McpRawClient calls", () => {
  test("validates against the imported JSON Schema before issuing tools/call", async () => {
    const protocol = new FakeProtocol([{ tools: [SEARCH_TOOL] }]);
    const client = makeClient(protocol);
    await client.connect();
    const catalog = await client.refreshCatalog();
    const ref = {
      kind: "mcp" as const,
      connectionId: "conn_1",
      remoteName: "search",
      catalogRevision: catalog.revision,
    };

    await assertMcpError(client.callTool(ref, { query: 42 }), "invalid_arguments");
    assert.equal(protocol.calls.length, 0, "invalid model output must not reach the server");

    const result = await client.callTool(ref, { query: "hello" });
    assert.equal(result.outcome, "completed");
    assert.deepEqual(protocol.calls, [{ name: "search", args: { query: "hello" } }]);
  });

  test("rejects a stale descriptor revision and a cross-connection ref", async () => {
    const protocol = new FakeProtocol([{ tools: [SEARCH_TOOL] }]);
    const client = makeClient(protocol);
    await client.connect();
    await client.refreshCatalog();

    await assertMcpError(
      client.callTool(
        {
          kind: "mcp",
          connectionId: "conn_1",
          remoteName: "search",
          catalogRevision: "sha256:stale",
        },
        { query: "hello" },
      ),
      "catalog_stale",
    );
    await assertMcpError(
      client.callTool(
        {
          kind: "mcp",
          connectionId: "conn_other",
          remoteName: "search",
          catalogRevision: client.catalog!.revision,
        },
        { query: "hello" },
      ),
      "unknown_tool",
    );
    assert.equal(protocol.calls.length, 0);
  });

  test("does not silently invoke tools that require experimental Tasks", async () => {
    const taskTool = tool(
      "long_job",
      { type: "object", properties: {} },
      { execution: { taskSupport: "required" } },
    );
    const protocol = new FakeProtocol([{ tools: [taskTool] }]);
    const client = makeClient(protocol);
    await client.connect();
    const catalog = await client.refreshCatalog();

    await assertMcpError(
      client.callTool(
        {
          kind: "mcp",
          connectionId: "conn_1",
          remoteName: "long_job",
          catalogRevision: catalog.revision,
        },
        {},
      ),
      "unsupported_task_tool",
    );
    assert.equal(protocol.calls.length, 0);
  });

  test("preserves tool error state and bounds oversized untrusted results", async () => {
    const protocol = new FakeProtocol([{ tools: [SEARCH_TOOL] }]);
    protocol.callResult = {
      content: [{ type: "text", text: "x".repeat(40_000) }],
      isError: true,
    };
    const client = makeClient(protocol);
    await client.connect();
    const catalog = await client.refreshCatalog();

    const result = await client.callTool(
      {
        kind: "mcp",
        connectionId: "conn_1",
        remoteName: "search",
        catalogRevision: catalog.revision,
      },
      { query: "hello" },
    );

    assert.equal(result.outcome, "tool_error");
    assert.equal(result.truncation?.handleEligible, true);
    assert.ok(JSON.stringify(result.result).length < 33_000);
  });

  test("validates successful structured output against the complete catalog", async () => {
    const outputTool = tool(
      "typed",
      { type: "object", properties: {} },
      {
        outputSchema: {
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
          additionalProperties: false,
        },
      },
    );
    const protocol = new FakeProtocol([{ tools: [outputTool] }]);
    protocol.callResult = {
      content: [{ type: "text", text: "bad" }],
      structuredContent: { count: "not-a-number" },
    };
    const client = makeClient(protocol);
    await client.connect();
    const catalog = await client.refreshCatalog();

    await assertMcpError(
      client.callTool(
        {
          kind: "mcp",
          connectionId: "conn_1",
          remoteName: "typed",
          catalogRevision: catalog.revision,
        },
        {},
      ),
      "invalid_output",
    );
  });

  test("an invalid_output error carries the census computed at response time", async () => {
    const outputTool = tool(
      "typed",
      { type: "object", properties: {} },
      {
        outputSchema: {
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
          additionalProperties: false,
        },
      },
    );
    const protocol = new FakeProtocol([{ tools: [outputTool] }]);
    // Structured content that violates the declared schema → invalid_output,
    // thrown AFTER the response crossed the wire.
    protocol.callResult = {
      content: [{ type: "text", text: "bad" }],
      structuredContent: { count: "not-a-number" },
    };
    const client = makeClient(protocol);
    await client.connect();
    const catalog = await client.refreshCatalog();

    const err = await client
      .callTool(
        { kind: "mcp", connectionId: "conn_1", remoteName: "typed", catalogRevision: catalog.revision },
        {},
      )
      .then(
        () => {
          throw new Error("expected invalid_output");
        },
        (e: unknown) => e,
      );

    assert.ok(err instanceof McpClientError && err.code === "invalid_output");
    // The census rides on the error so the broker can persist provenance for an
    // otherwise-ambiguous outcome (#541); `outputSchemaValidated: false` is the
    // fact that explains the failure.
    assert.deepEqual(err.provenance, {
      isError: false,
      hasStructuredContent: true,
      outputSchemaValidated: false,
      contentBlockCount: 1,
      contentKinds: { text: 1 },
      truncated: false,
    });
  });

  test("captures a payload-free result-provenance census on the call envelope", async () => {
    const outputTool = tool(
      "typed",
      { type: "object", properties: {} },
      {
        outputSchema: {
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
          additionalProperties: false,
        },
      },
    );
    const protocol = new FakeProtocol([{ tools: [outputTool] }]);
    // Mixed content kinds — a returned resource_link is counted, never fetched.
    protocol.callResult = {
      content: [
        { type: "text", text: "hi" },
        { type: "text", text: "there" },
        { type: "image", data: "…", mimeType: "image/png" },
        { type: "resource_link", uri: "https://example.test/secret.pdf", name: "r" },
      ],
      structuredContent: { count: 2 },
    };
    const client = makeClient(protocol);
    await client.connect();
    const catalog = await client.refreshCatalog();

    const result = await client.callTool(
      {
        kind: "mcp",
        connectionId: "conn_1",
        remoteName: "typed",
        catalogRevision: catalog.revision,
      },
      {},
    );

    assert.equal(result.outcome, "completed");
    assert.deepEqual(result.provenance, {
      isError: false,
      hasStructuredContent: true,
      outputSchemaValidated: true,
      contentBlockCount: 4,
      contentKinds: { text: 2, image: 1, resource_link: 1 },
      truncated: false,
    });
    // Payload-free: the returned resource-link URI never appears in provenance.
    assert.ok(!JSON.stringify(result.provenance).includes("secret.pdf"));
  });

  test("provenance reflects a server tool_error and an oversized-result truncation", async () => {
    const protocol = new FakeProtocol([{ tools: [SEARCH_TOOL] }]);
    protocol.callResult = {
      content: [{ type: "text", text: "x".repeat(40_000) }],
      isError: true,
    };
    const client = makeClient(protocol);
    await client.connect();
    const catalog = await client.refreshCatalog();

    const result = await client.callTool(
      {
        kind: "mcp",
        connectionId: "conn_1",
        remoteName: "search",
        catalogRevision: catalog.revision,
      },
      { query: "hello" },
    );

    assert.equal(result.outcome, "tool_error");
    // isError is captured, the output validator is skipped for a tool error, and the
    // bounded model projection is flagged truncated on the provenance envelope.
    assert.equal(result.provenance.isError, true);
    assert.equal(result.provenance.outputSchemaValidated, false);
    assert.equal(result.provenance.truncated, true);
    assert.deepEqual(result.provenance.contentKinds, { text: 1 });
  });

  test("turns session-expiry 404 into reconnect-required state without retrying the call", async () => {
    const protocol = new FakeProtocol([{ tools: [SEARCH_TOOL] }]);
    protocol.callError = new StreamableHTTPError(404, "session expired");
    const client = makeClient(protocol);
    await client.connect();
    const catalog = await client.refreshCatalog();

    await assertMcpError(
      client.callTool(
        {
          kind: "mcp",
          connectionId: "conn_1",
          remoteName: "search",
          catalogRevision: catalog.revision,
        },
        { query: "hello" },
      ),
      "session_expired",
    );

    assert.equal(protocol.calls.length, 0, "an expired write-capable call must never auto-retry");
    assert.equal(client.catalog, null);
    assert.equal(client.negotiatedServer, null);
    await assertMcpError(client.refreshCatalog(), "not_connected");
  });

  test("close can explicitly terminate a remote session and clears the catalog", async () => {
    const protocol = new FakeProtocol([{ tools: [SEARCH_TOOL] }]);
    const client = makeClient(protocol);
    await client.connect();
    await client.refreshCatalog();

    await client.close({ terminateSession: true });

    assert.equal(protocol.closedWithTerminate, true);
    assert.equal(client.catalog, null);
    await assertMcpError(client.refreshCatalog(), "not_connected");
  });
});
