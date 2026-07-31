import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { after, before, test } from "node:test";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { isRecord } from "@alfred/contracts";
import { z } from "zod";
import { McpRawClient } from "../../src/modules/mcp";

let endpoint: URL;
let closeServer: (() => Promise<void>) | null = null;
let closeHandler: (() => Promise<void>) | null = null;
let notifyModernToolsChanged: (() => void) | null = null;
const observedCalls: string[] = [];
const observedLegacyCalls: string[] = [];
const observedLegacyMethods: string[] = [];

before(async () => {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "alfred-mcp-test", version: "1" });
    server.registerTool(
      "echo",
      {
        description: "Echo one string through a real Streamable HTTP tools/call.",
        inputSchema: { value: z.string() },
        outputSchema: { echoed: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ value }) => {
        observedCalls.push(value);
        return {
          content: [{ type: "text", text: value }],
          structuredContent: { echoed: value },
        };
      },
    );
    return server;
  });
  closeHandler = handler.close;
  notifyModernToolsChanged = () => handler.notify.toolsChanged();
  const serveMcp = toNodeHandler(handler);
  const httpServer = createServer(async (req, res) => {
    if (req.url === "/mcp") {
      await serveMcp(req, res);
      return;
    }
    if (req.url === "/legacy-mcp" && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      assert.ok(isRecord(message));
      const id = message.id;
      if (typeof message.method === "string") observedLegacyMethods.push(message.method);
      if (message.method === "server/discover") {
        writeJson(res, {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Method not found" },
        });
        return;
      }
      if (message.method === "initialize") {
        writeJson(res, {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "alfred-legacy-test", version: "1" },
          },
        });
        return;
      }
      if (message.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (message.method === "tools/list") {
        const cursor = isRecord(message.params) ? message.params.cursor : undefined;
        writeJson(res, {
          jsonrpc: "2.0",
          id,
          result: {
            tools:
              cursor === "page-2"
                ? [
                    {
                      name: "legacy_extra",
                      inputSchema: {
                        type: "object",
                        properties: {},
                        additionalProperties: false,
                      },
                    },
                  ]
                : [
                    {
                      name: "legacy_echo",
                      inputSchema: {
                        type: "object",
                        properties: { value: { type: "string" } },
                        required: ["value"],
                        additionalProperties: false,
                      },
                    },
                  ],
            ...(cursor === "page-2" ? {} : { nextCursor: "page-2" }),
          },
        });
        return;
      }
      if (message.method === "tools/call") {
        assert.ok(isRecord(message.params));
        assert.ok(isRecord(message.params.arguments));
        const value = message.params.arguments.value;
        assert.equal(typeof value, "string");
        observedLegacyCalls.push(value);
        writeJson(res, {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: value }] },
        });
        return;
      }
      writeJson(res, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" },
      });
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  closeServer = () =>
    new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
});

after(async () => {
  await closeHandler?.();
  await closeServer?.();
});

test("McpRawClient negotiates, catalogs, and calls a real Streamable HTTP server", async () => {
  const wire: Array<{ method: string; sessionId: string | null }> = [];
  const client = new McpRawClient({
    connectionId: "conn_http_test",
    endpoint,
    // Production supplies the hardened URL/SSRF authorizer. This explicit test
    // policy is the only place loopback HTTP is admitted.
    endpointAuthorization: { authorize: async (candidate) => new URL(candidate.href) },
    fetch: async (input, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (isRecord(body) && typeof body.method === "string") {
        wire.push({
          method: body.method,
          sessionId: new Headers(init?.headers).get("mcp-session-id"),
        });
      }
      return fetch(input, init);
    },
  });

  await client.connect();
  assert.equal(client.negotiatedServer?.protocolEra, "post_2026_07_28");
  assert.equal(client.negotiatedServer?.protocolVersion, "2026-07-28");
  assert.equal(client.negotiatedServer?.serverName, "alfred-mcp-test");
  assert.ok(wire.some((entry) => entry.method === "server/discover"));
  assert.ok(!wire.some((entry) => entry.method === "initialize"));
  assert.ok(wire.every((entry) => entry.sessionId === null));

  const catalog = await client.refreshCatalog();
  assert.deepEqual(
    catalog.tools.map((tool) => tool.name),
    ["echo"],
  );
  const result = await client.callTool(
    {
      kind: "mcp",
      connectionId: "conn_http_test",
      remoteName: "echo",
      catalogRevision: catalog.revision,
    },
    { value: "raw, not nested Code Mode" },
  );

  assert.equal(result.outcome, "completed");
  assert.deepEqual(observedCalls, ["raw, not nested Code Mode"]);
  assert.ok(isRecord(result.result));
  assert.deepEqual(result.result.content, [{ type: "text", text: "raw, not nested Code Mode" }]);
  assert.deepEqual(result.result.structuredContent, {
    echoed: "raw, not nested Code Mode",
  });
  notifyModernToolsChanged?.();
  await waitFor(() => client.catalog === null);
  await client.close();
});

test("McpRawClient falls back to a 2025-11-25 Streamable HTTP server", async () => {
  const client = new McpRawClient({
    connectionId: "conn_legacy_http_test",
    endpoint: new URL("/legacy-mcp", endpoint),
    endpointAuthorization: { authorize: async (candidate) => new URL(candidate.href) },
  });

  await client.connect();
  assert.equal(client.negotiatedServer?.protocolEra, "pre_2026_07_28");
  assert.equal(client.negotiatedServer?.protocolVersion, "2025-11-25");
  assert.equal(client.negotiatedServer?.serverName, "alfred-legacy-test");
  assert.equal(observedLegacyMethods.filter((method) => method === "server/discover").length, 1);
  assert.equal(observedLegacyMethods.filter((method) => method === "initialize").length, 1);

  const catalog = await client.refreshCatalog();
  assert.deepEqual(
    catalog.tools.map((tool) => tool.name),
    ["legacy_echo", "legacy_extra"],
  );
  assert.equal(observedLegacyMethods.filter((method) => method === "tools/list").length, 2);
  const result = await client.callTool(
    {
      kind: "mcp",
      connectionId: "conn_legacy_http_test",
      remoteName: "legacy_echo",
      catalogRevision: catalog.revision,
    },
    { value: "fallback once" },
  );

  assert.equal(result.outcome, "completed");
  assert.deepEqual(observedLegacyCalls, ["fallback once"]);
  await client.close();
});

test("the real SDK cannot bypass Alfred's catalog page limit", async () => {
  const client = new McpRawClient({
    connectionId: "conn_legacy_page_limit_test",
    endpoint: new URL("/legacy-mcp", endpoint),
    endpointAuthorization: { authorize: async (candidate) => new URL(candidate.href) },
    maxCatalogPages: 1,
  });

  await client.connect();
  await assert.rejects(
    client.refreshCatalog(),
    (err: unknown) =>
      err instanceof Error && "code" in err && Reflect.get(err, "code") === "catalog_limit",
  );
  await client.close();
});

test("the real SDK does not replay tools/call after auth or header failures", async () => {
  let unauthorizedCalls = 0;
  let unauthorizedRefreshes = 0;
  const unauthorizedClient = new McpRawClient({
    connectionId: "conn_no_auth_replay_test",
    endpoint,
    endpointAuthorization: { authorize: async (candidate) => new URL(candidate.href) },
    authProvider: {
      token: async () => "test-token",
      onUnauthorized: async () => {
        unauthorizedRefreshes += 1;
      },
    },
    fetch: async (input, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (isRecord(body) && body.method === "tools/call") {
        unauthorizedCalls += 1;
        return new Response("", {
          status: 401,
          headers: { "www-authenticate": "Bearer" },
        });
      }
      return fetch(input, init);
    },
  });
  await unauthorizedClient.connect();
  const unauthorizedCatalog = await unauthorizedClient.refreshCatalog();
  await assert.rejects(
    unauthorizedClient.callTool(
      {
        kind: "mcp",
        connectionId: "conn_no_auth_replay_test",
        remoteName: "echo",
        catalogRevision: unauthorizedCatalog.revision,
      },
      { value: "once" },
    ),
  );
  assert.equal(unauthorizedCalls, 1);
  assert.equal(unauthorizedRefreshes, 0);
  await unauthorizedClient.close();

  let insufficientScopeCalls = 0;
  const insufficientScopeClient = new McpRawClient({
    connectionId: "conn_no_scope_replay_test",
    endpoint,
    endpointAuthorization: { authorize: async (candidate) => new URL(candidate.href) },
    authProvider: { token: async () => "test-token" },
    fetch: async (input, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (isRecord(body) && body.method === "tools/call") {
        insufficientScopeCalls += 1;
        return new Response("", {
          status: 403,
          headers: {
            "www-authenticate": 'Bearer error="insufficient_scope", scope="write"',
          },
        });
      }
      return fetch(input, init);
    },
  });
  await insufficientScopeClient.connect();
  const insufficientScopeCatalog = await insufficientScopeClient.refreshCatalog();
  await assert.rejects(
    insufficientScopeClient.callTool(
      {
        kind: "mcp",
        connectionId: "conn_no_scope_replay_test",
        remoteName: "echo",
        catalogRevision: insufficientScopeCatalog.revision,
      },
      { value: "once" },
    ),
  );
  assert.equal(insufficientScopeCalls, 1);
  await insufficientScopeClient.close();

  let mismatchCalls = 0;
  const mismatchClient = new McpRawClient({
    connectionId: "conn_no_header_replay_test",
    endpoint,
    endpointAuthorization: { authorize: async (candidate) => new URL(candidate.href) },
    fetch: async (input, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (isRecord(body) && body.method === "tools/call") {
        mismatchCalls += 1;
        return Response.json(
          {
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32020, message: "HEADER_MISMATCH" },
          },
          { status: 400 },
        );
      }
      return fetch(input, init);
    },
  });
  await mismatchClient.connect();
  const mismatchCatalog = await mismatchClient.refreshCatalog();
  await assert.rejects(
    mismatchClient.callTool(
      {
        kind: "mcp",
        connectionId: "conn_no_header_replay_test",
        remoteName: "echo",
        catalogRevision: mismatchCatalog.revision,
      },
      { value: "once" },
    ),
  );
  assert.equal(mismatchCalls, 1);
  await mismatchClient.close();
});

function writeJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for MCP wire event");
}
