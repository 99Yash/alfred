import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ProtocolError, SdkErrorCode, SdkHttpError, type Tool } from "@modelcontextprotocol/client";
import {
  McpClientError,
  McpRawClient,
  type McpProtocolCallResult,
  type McpProtocolClient,
  type McpProtocolPage,
  type McpProtocolServer,
} from "../../src/connections/mcp";
import { isPreDeliveryErrorCode } from "../../src/connections/mcp/errors";
import { permissiveMcpEndpointAuthorizerForTests } from "../../src/connections/mcp/test-support";

type FakePage = Omit<McpProtocolPage, "ttlMs" | "cacheScope"> &
  Partial<Pick<McpProtocolPage, "ttlMs" | "cacheScope">>;

class FakeProtocol implements McpProtocolClient {
  readonly pages: McpProtocolPage[];
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  listCalls = 0;
  connectCalls = 0;
  closeCalls = 0;
  connected = false;
  closedWithTerminate: boolean | null = null;
  callResult: McpProtocolCallResult = { content: [{ type: "text", text: "ok" }] };
  connectError: Error | null = null;
  negotiated: McpProtocolServer = {
    protocolEra: "pre_2026_07_28",
    protocolVersion: "2025-11-25",
    serverName: "fake",
    serverVersion: "1",
    hasTools: true,
    toolsListChanged: true,
  };
  callError: Error | null = null;
  listHook: (() => void | Promise<void>) | null = null;
  closeHook: (() => void | Promise<void>) | null = null;
  #toolsChanged: (() => void | Promise<void>) | null = null;
  #connectionUnhealthy: ((error: Error) => void | Promise<void>) | null = null;

  constructor(pages: FakePage[]) {
    this.pages = pages.map((page) => ({
      ttlMs: 0,
      cacheScope: "private",
      ...page,
    }));
  }

  async connect(): Promise<McpProtocolServer> {
    this.connectCalls += 1;
    if (this.connectError) throw this.connectError;
    this.connected = true;
    return this.negotiated;
  }

  async close(terminateSession: boolean): Promise<void> {
    this.closeCalls += 1;
    this.closedWithTerminate = terminateSession;
    await this.closeHook?.();
  }

  async listTools(cursor: string | undefined): Promise<McpProtocolPage> {
    this.listCalls += 1;
    await this.listHook?.();
    const index = cursor ? Number(cursor) : 0;
    const page = this.pages[index];
    if (!page) return { tools: [], ttlMs: 0, cacheScope: "private" };
    return page;
  }

  async callTool(tool: Tool, args: Record<string, unknown>): Promise<McpProtocolCallResult> {
    this.calls.push({ name: tool.name, args });
    if (this.callError) throw this.callError;
    return this.callResult;
  }

  onToolsChanged(handler: () => void | Promise<void>): void {
    this.#toolsChanged = handler;
  }

  onConnectionUnhealthy(handler: (error: Error) => void | Promise<void>): void {
    this.#connectionUnhealthy = handler;
  }

  async emitToolsChanged(): Promise<void> {
    await this.#toolsChanged?.();
  }

  async emitConnectionUnhealthy(error = new Error("subscription closed")): Promise<void> {
    await this.#connectionUnhealthy?.(error);
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function makeClient(
  protocol: FakeProtocol,
  overrides: Partial<ConstructorParameters<typeof McpRawClient>[0]> = {},
) {
  return new McpRawClient({
    connectionId: "conn_1",
    endpoint: new URL("https://mcp.example.test/mcp"),
    expectedOrigin: "https://mcp.example.test",
    endpointAuthorizer: permissiveMcpEndpointAuthorizerForTests(),
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
      endpointAuthorizer: {
        authorize: async (candidate) => {
          const endpoint = new URL(String(candidate.endpoint));
          events.push(`authorize:${endpoint.href}`);
          return permissiveMcpEndpointAuthorizerForTests().authorize(candidate);
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

  test("closes endpoint authorization when the OAuth provider factory throws", async () => {
    const protocol = new FakeProtocol([{ tools: [] }]);
    const fallback = permissiveMcpEndpointAuthorizerForTests();
    let authorizationCloses = 0;
    const client = makeClient(protocol, {
      endpointAuthorizer: {
        authorize: async (candidate) => {
          const authorized = await fallback.authorize(candidate);
          return {
            ...authorized,
            close: async () => {
              authorizationCloses += 1;
              await authorized.close();
            },
          };
        },
      },
      oauthProviderFactory: () => {
        throw new Error("provider construction failed");
      },
    });

    await assert.rejects(client.connect(), /provider construction failed/);

    assert.equal(authorizationCloses, 1);
    assert.equal(protocol.connectCalls, 0);
    assert.equal(protocol.closeCalls, 0);
  });

  test("waits for a pending connect before close and releases its generation once", async () => {
    const protocol = new FakeProtocol([{ tools: [] }]);
    const pendingAuthorization =
      deferred<
        Awaited<ReturnType<ReturnType<typeof permissiveMcpEndpointAuthorizerForTests>["authorize"]>>
      >();
    const authorizationStarted = deferred<void>();
    let authorizationCloses = 0;
    const client = makeClient(protocol, {
      endpointAuthorizer: {
        authorize: async () => {
          authorizationStarted.resolve();
          const authorized = await pendingAuthorization.promise;
          return {
            ...authorized,
            close: async () => {
              authorizationCloses += 1;
              await authorized.close();
            },
          };
        },
      },
    });

    const connect = client.connect();
    await authorizationStarted.promise;
    const close = client.close();
    pendingAuthorization.resolve(
      await permissiveMcpEndpointAuthorizerForTests().authorize({
        endpoint: "https://mcp.example.test/mcp",
        expectedOrigin: "https://mcp.example.test",
      }),
    );
    await Promise.all([connect, close]);

    assert.equal(protocol.connectCalls, 1);
    assert.equal(protocol.closeCalls, 1);
    assert.equal(authorizationCloses, 1);
    await assertMcpError(client.refreshCatalog(), "not_connected");
  });

  test("coalesces concurrent connects into one authorization and protocol generation", async () => {
    const protocol = new FakeProtocol([{ tools: [] }]);
    const fallback = permissiveMcpEndpointAuthorizerForTests();
    let authorizations = 0;
    let protocolFactories = 0;
    const client = makeClient(protocol, {
      endpointAuthorizer: {
        authorize: async (candidate) => {
          authorizations += 1;
          return fallback.authorize(candidate);
        },
      },
      protocolFactory: () => {
        protocolFactories += 1;
        return protocol;
      },
    });

    await Promise.all([client.connect(), client.connect()]);

    assert.equal(authorizations, 1);
    assert.equal(protocolFactories, 1);
    assert.equal(protocol.connectCalls, 1);
    await client.close();
    assert.equal(protocol.closeCalls, 1);
  });

  test("passes correlated OAuth and protocol capabilities through raw client wiring", async () => {
    const protocol = new FakeProtocol([{ tools: [] }]);
    let refreshRequests = 0;
    const endpointAuthorizer = permissiveMcpEndpointAuthorizerForTests(async (input) => {
      assert.equal(String(input), "https://auth.example.test/token");
      refreshRequests += 1;
      return new Response(
        JSON.stringify({ access_token: "fresh", token_type: "Bearer", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    let oauthCapability: object | null = null;
    let protocolCapability: object | null = null;
    const client = makeClient(protocol, {
      endpointAuthorizer,
      oauthProviderFactory: (authorization) => {
        oauthCapability = authorization;
        return {
          authorize: async () => {
            await authorization.fetch("https://auth.example.test/token");
            return "AUTHORIZED" as const;
          },
          refreshIfNeeded: async () => undefined,
          finishAuthorization: async () => undefined,
          accessToken: async () => "fresh",
        };
      },
      protocolFactory: (authorization) => {
        protocolCapability = authorization;
        return protocol;
      },
    });

    await client.connect();

    assert.ok(oauthCapability);
    assert.ok(protocolCapability);
    assert.notEqual(oauthCapability, protocolCapability);
    assert.equal(refreshRequests, 1);
    assert.equal(protocol.connectCalls, 1);
    await client.close();
  });

  test("reauthorizes the endpoint after close before reconnecting", async () => {
    const protocol = new FakeProtocol([{ tools: [] }]);
    let authorizations = 0;
    let closedAuthorizations = 0;
    const fallback = permissiveMcpEndpointAuthorizerForTests();
    const client = makeClient(protocol, {
      endpointAuthorizer: {
        authorize: async (candidate) => {
          authorizations += 1;
          const authorized = await fallback.authorize(candidate);
          return {
            ...authorized,
            close: async () => {
              closedAuthorizations += 1;
              await authorized.close();
            },
          };
        },
      },
    });

    await client.connect();
    await client.close();
    await client.connect();

    assert.equal(authorizations, 2);
    assert.equal(closedAuthorizations, 1);
    await client.close();
    assert.equal(closedAuthorizations, 2);
  });

  test("allows the 2025-11-25 and 2026-07-28 revisions, and rejects other versions", async () => {
    const modernProtocol = new FakeProtocol([{ tools: [] }]);
    modernProtocol.negotiated = {
      ...modernProtocol.negotiated,
      protocolEra: "post_2026_07_28",
      protocolVersion: "2026-07-28",
    };
    const modernClient = makeClient(modernProtocol);
    await modernClient.connect();
    assert.equal(modernClient.negotiatedServer?.protocolEra, "post_2026_07_28");

    const oldProtocol = new FakeProtocol([{ tools: [] }]);
    oldProtocol.negotiated.protocolVersion = "2025-06-18";
    const oldClient = makeClient(oldProtocol);
    await assertMcpError(oldClient.connect(), "unsupported_protocol_version");
    assert.equal(oldProtocol.closedWithTerminate, false);

    const mismatched = new FakeProtocol([{ tools: [] }]);
    mismatched.negotiated = {
      ...mismatched.negotiated,
      protocolEra: "post_2026_07_28",
      protocolVersion: "2025-11-25",
    };
    await assertMcpError(makeClient(mismatched).connect(), "unsupported_protocol_version");
  });

  test("requires the server tools capability", async () => {
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
    assert.equal(protocol.listCalls, 4, "ttlMs: 0 must fetch every page again");
  });

  test("uses page-one cache hints without allowing TTL to preserve stale authority", async () => {
    let now = 1_000;
    const replacement = tool("replacement", { type: "object", properties: {} });
    const protocol = new FakeProtocol([
      {
        tools: [SEARCH_TOOL],
        nextCursor: "1",
        ttlMs: 60_000,
        cacheScope: "public",
      },
      {
        tools: [],
        ttlMs: 1,
        cacheScope: "private",
      },
    ]);
    const client = makeClient(protocol, { now: () => now });
    await client.connect();

    const first = await client.refreshCatalog();
    assert.equal(first.ttlMs, 60_000);
    assert.equal(first.cacheScope, "public");
    assert.equal(protocol.listCalls, 2);

    now += 59_000;
    assert.equal(await client.refreshCatalog(), first);
    assert.equal(protocol.listCalls, 2, "a fresh positive TTL may avoid a wire refresh");

    protocol.pages.splice(0, protocol.pages.length, {
      tools: [replacement],
      ttlMs: 60_000,
      cacheScope: "private",
    });
    await protocol.emitToolsChanged();
    assert.equal(client.catalog, null);
    await assertMcpError(
      client.callTool(
        {
          kind: "mcp",
          connectionId: "conn_1",
          remoteName: "search",
          catalogRevision: first.revision,
        },
        { query: "stale" },
      ),
      "catalog_stale",
    );

    const second = await client.refreshCatalog();
    assert.equal(protocol.listCalls, 3, "list_changed must override the unexpired TTL");
    assert.notEqual(second.revision, first.revision);
    await assertMcpError(
      client.callTool(
        {
          kind: "mcp",
          connectionId: "conn_1",
          remoteName: "replacement",
          catalogRevision: first.revision,
        },
        {},
      ),
      "catalog_stale",
    );
    assert.equal(protocol.calls.length, 0);
  });

  test("refreshes an expired catalog before preparing a tool call", async () => {
    let now = 1_000;
    const protocol = new FakeProtocol([
      {
        tools: [SEARCH_TOOL],
        ttlMs: 1_000,
      },
    ]);
    const client = makeClient(protocol, { now: () => now });
    await client.connect();
    const catalog = await client.refreshCatalog();

    now += 1_001;
    protocol.pages.splice(0, 1, {
      tools: [tool("replacement", { type: "object", properties: {} })],
      ttlMs: 1_000,
      cacheScope: "private",
    });

    await assertMcpError(
      client.callTool(
        {
          kind: "mcp",
          connectionId: "conn_1",
          remoteName: "search",
          catalogRevision: catalog.revision,
        },
        { query: "stale" },
      ),
      "catalog_stale",
    );
    assert.equal(protocol.listCalls, 2);
    assert.equal(protocol.calls.length, 0);
    assert.deepEqual(
      client.catalog?.tools.map((entry) => entry.name),
      ["replacement"],
    );
  });

  test("invalidates a TTL-held catalog after HEADER_MISMATCH without replaying", async () => {
    const protocol = new FakeProtocol([
      {
        tools: [SEARCH_TOOL],
        ttlMs: 60_000,
      },
    ]);
    const client = makeClient(protocol, { now: () => 1_000 });
    await client.connect();
    const catalog = await client.refreshCatalog();
    protocol.callError = new ProtocolError(-32020, "HEADER_MISMATCH");

    await assertMcpError(
      client.callTool(
        {
          kind: "mcp",
          connectionId: "conn_1",
          remoteName: "search",
          catalogRevision: catalog.revision,
        },
        { query: "once" },
      ),
      "descriptor_mismatch",
    );

    assert.equal(client.catalog, null);
    assert.equal(protocol.listCalls, 1);
    assert.equal(protocol.calls.length, 1);
    assert.equal(
      isPreDeliveryErrorCode("descriptor_mismatch"),
      false,
      "a remote mismatch response crossed the delivery boundary",
    );
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

    const modelSelectedHeader = new FakeProtocol([
      {
        tools: [
          tool("header_channel", {
            type: "object",
            properties: {
              tenant: {
                type: "string",
                "x-mcp-header": "tenant",
              },
            },
          } as Tool["inputSchema"]),
        ],
      },
    ]);
    const headerClient = makeClient(modelSelectedHeader);
    await headerClient.connect();
    await assertMcpError(headerClient.refreshCatalog(), "invalid_schema");
  });

  test("supports local $ref within schema bounds and rejects over-deep local schemas", async () => {
    const localRefTool = tool(
      "local_ref",
      { type: "object", properties: {} },
      {
        outputSchema: {
          $defs: {
            result: {
              type: "array",
              items: { type: "integer" },
            },
          },
          $ref: "#/$defs/result",
        } as NonNullable<Tool["outputSchema"]>,
      },
    );
    const localProtocol = new FakeProtocol([{ tools: [localRefTool] }]);
    localProtocol.callResult = {
      content: [{ type: "text", text: "ok" }],
      structuredContent: [1, 2, 3],
    } as McpProtocolCallResult;
    const localClient = makeClient(localProtocol);
    await localClient.connect();
    const catalog = await localClient.refreshCatalog();

    const result = await localClient.callTool(
      {
        kind: "mcp",
        connectionId: "conn_1",
        remoteName: "local_ref",
        catalogRevision: catalog.revision,
      },
      {},
    );
    assert.equal(result.provenance.outputSchemaValidated, true);

    let overDeep = JSON.parse('{ "$ref": "#/$defs/result" }') as Record<string, unknown>;
    for (let depth = 0; depth < 40; depth += 1) {
      overDeep = { allOf: [overDeep] };
    }
    overDeep.$defs = { result: { type: "string" } };
    const overDeepProtocol = new FakeProtocol([
      {
        tools: [
          tool(
            "over_deep_local_ref",
            { type: "object", properties: {} },
            {
              outputSchema: overDeep as NonNullable<Tool["outputSchema"]>,
            },
          ),
        ],
      },
    ]);
    const overDeepClient = makeClient(overDeepProtocol);
    await overDeepClient.connect();
    await assertMcpError(overDeepClient.refreshCatalog(), "invalid_schema");
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

  test("a list_changed notification refreshes authority before the next call", async () => {
    const protocol = new FakeProtocol([{ tools: [SEARCH_TOOL] }]);
    const client = makeClient(protocol);
    await client.connect();
    const catalog = await client.refreshCatalog();
    await protocol.emitToolsChanged();

    assert.equal(client.catalog, null);
    const result = await client.callTool(
      {
        kind: "mcp",
        connectionId: "conn_1",
        remoteName: "search",
        catalogRevision: catalog.revision,
      },
      { query: "hello" },
    );
    assert.equal(result.outcome, "completed");
    assert.equal(protocol.listCalls, 2);
    assert.equal(protocol.calls.length, 1);
  });

  test("does not commit a snapshot invalidated during pagination", async () => {
    const protocol = new FakeProtocol([{ tools: [SEARCH_TOOL] }]);
    const client = makeClient(protocol);
    await client.connect();
    protocol.listHook = async () => protocol.emitToolsChanged();

    await assertMcpError(client.refreshCatalog(), "catalog_stale");

    assert.equal(client.catalog, null);
  });

  test("a lost invalidation channel drops protocol and catalog authority", async () => {
    const protocol = new FakeProtocol([{ tools: [SEARCH_TOOL] }]);
    const client = makeClient(protocol);
    await client.connect();
    await client.refreshCatalog();

    await protocol.emitConnectionUnhealthy();

    assert.equal(client.catalog, null);
    assert.equal(client.negotiatedServer, null);
    await assertMcpError(client.refreshCatalog(), "not_connected");
  });

  test("close and reconnect join unhealthy generation cleanup before authorizing again", async () => {
    const firstProtocol = new FakeProtocol([{ tools: [] }]);
    const secondProtocol = new FakeProtocol([{ tools: [] }]);
    const releaseProtocolClose = deferred<void>();
    const protocolCloseStarted = deferred<void>();
    const events: string[] = [];
    firstProtocol.closeHook = async () => {
      events.push("protocol-a-close");
      protocolCloseStarted.resolve();
      await releaseProtocolClose.promise;
    };
    const fallback = permissiveMcpEndpointAuthorizerForTests();
    let authorizationCount = 0;
    let protocolCount = 0;
    const client = makeClient(firstProtocol, {
      endpointAuthorizer: {
        authorize: async (candidate) => {
          authorizationCount += 1;
          const authorizationNumber = authorizationCount;
          events.push(`authorize-${authorizationNumber}`);
          const authorized = await fallback.authorize(candidate);
          return {
            ...authorized,
            close: async () => {
              events.push(`authorization-${authorizationNumber}-close`);
              await authorized.close();
            },
          };
        },
      },
      protocolFactory: () => {
        protocolCount += 1;
        return protocolCount === 1 ? firstProtocol : secondProtocol;
      },
    });

    await client.connect();
    await firstProtocol.emitConnectionUnhealthy();
    await protocolCloseStarted.promise;
    const close = client.close();
    const reconnect = client.connect();
    await Promise.resolve();

    assert.equal(authorizationCount, 1, "generation B must wait for generation A cleanup");
    releaseProtocolClose.resolve();
    await close;
    await reconnect;

    assert.equal(firstProtocol.closeCalls, 1);
    assert.equal(secondProtocol.connectCalls, 1);
    assert.deepEqual(events.slice(0, 4), [
      "authorize-1",
      "protocol-a-close",
      "authorization-1-close",
      "authorize-2",
    ]);
    await client.close();
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

  test("ignores the legacy execution.taskSupport field", async () => {
    const taskTool = tool(
      "long_job",
      { type: "object", properties: {} },
      { execution: { taskSupport: "required" } },
    );
    const protocol = new FakeProtocol([{ tools: [taskTool] }]);
    const client = makeClient(protocol);
    await client.connect();
    const catalog = await client.refreshCatalog();

    const result = await client.callTool(
      {
        kind: "mcp",
        connectionId: "conn_1",
        remoteName: "long_job",
        catalogRevision: catalog.revision,
      },
      {},
    );

    assert.equal(result.outcome, "completed");
    assert.deepEqual(protocol.calls, [{ name: "long_job", args: {} }]);
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

  test("validates every JSON structuredContent shape and non-object output roots", async () => {
    const cases: Array<{
      name: string;
      outputSchema: NonNullable<Tool["outputSchema"]>;
      structuredContent: unknown;
    }> = [
      {
        name: "primitive",
        outputSchema: { type: "string" } as NonNullable<Tool["outputSchema"]>,
        structuredContent: "ready",
      },
      {
        name: "array",
        outputSchema: {
          type: "array",
          items: { type: "number" },
        } as NonNullable<Tool["outputSchema"]>,
        structuredContent: [1, 2, 3],
      },
      {
        name: "object",
        outputSchema: {
          type: "object",
          properties: { ready: { const: true } },
          required: ["ready"],
          additionalProperties: false,
        },
        structuredContent: { ready: true },
      },
      {
        name: "null",
        outputSchema: { type: "null" } as NonNullable<Tool["outputSchema"]>,
        structuredContent: null,
      },
    ];

    for (const fixture of cases) {
      const protocol = new FakeProtocol([
        {
          tools: [
            tool(
              fixture.name,
              { type: "object", properties: {} },
              {
                outputSchema: fixture.outputSchema,
              },
            ),
          ],
        },
      ]);
      protocol.callResult = {
        content: [{ type: "text", text: fixture.name }],
        structuredContent: fixture.structuredContent,
      } as McpProtocolCallResult;
      const client = makeClient(protocol);
      await client.connect();
      const catalog = await client.refreshCatalog();

      const result = await client.callTool(
        {
          kind: "mcp",
          connectionId: "conn_1",
          remoteName: fixture.name,
          catalogRevision: catalog.revision,
        },
        {},
      );

      assert.equal(result.outcome, "completed", fixture.name);
      assert.equal(result.provenance.outputSchemaValidated, true, fixture.name);
      assert.deepEqual(
        (result.result as { structuredContent: unknown }).structuredContent,
        fixture.structuredContent,
        fixture.name,
      );
    }
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
        {
          kind: "mcp",
          connectionId: "conn_1",
          remoteName: "typed",
          catalogRevision: catalog.revision,
        },
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
    protocol.callError = new SdkHttpError(
      SdkErrorCode.ClientHttpFailedToOpenStream,
      "session expired",
      { status: 404 },
    );
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

    assert.equal(protocol.calls.length, 1, "an expired write-capable call must never auto-retry");
    assert.equal(client.catalog, null);
    assert.equal(client.negotiatedServer, null);
    await assertMcpError(client.refreshCatalog(), "not_connected");
  });

  test("does not treat a post_2026_07_28 404 as a pre_2026_07_28 session expiry", async () => {
    const protocol = new FakeProtocol([{ tools: [SEARCH_TOOL] }]);
    protocol.negotiated = {
      ...protocol.negotiated,
      protocolEra: "post_2026_07_28",
      protocolVersion: "2026-07-28",
    };
    const http404 = new SdkHttpError(
      SdkErrorCode.ClientHttpFailedToOpenStream,
      "modern route missing",
      { status: 404 },
    );
    protocol.callError = http404;
    const client = makeClient(protocol);
    await client.connect();
    const catalog = await client.refreshCatalog();

    await assert.rejects(
      client.callTool(
        {
          kind: "mcp",
          connectionId: "conn_1",
          remoteName: "search",
          catalogRevision: catalog.revision,
        },
        { query: "hello" },
      ),
      (err: unknown) => err === http404,
    );

    assert.equal(client.catalog?.revision, catalog.revision);
    assert.equal(client.negotiatedServer?.protocolEra, "post_2026_07_28");
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
