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
const observedCalls: string[] = [];
const observedLegacyCalls: string[] = [];

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
        writeJson(res, {
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
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
  const client = new McpRawClient({
    connectionId: "conn_http_test",
    endpoint,
    // Production supplies the hardened URL/SSRF authorizer. This explicit test
    // policy is the only place loopback HTTP is admitted.
    endpointAuthorization: { authorize: async (candidate) => new URL(candidate.href) },
  });

  await client.connect();
  assert.equal(client.negotiatedServer?.protocolEra, "modern");
  assert.equal(client.negotiatedServer?.protocolVersion, "2026-07-28");
  assert.equal(client.negotiatedServer?.serverName, "alfred-mcp-test");

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
  await client.close();
});

test("McpRawClient falls back to a legacy Streamable HTTP server", async () => {
  const client = new McpRawClient({
    connectionId: "conn_legacy_http_test",
    endpoint: new URL("/legacy-mcp", endpoint),
    endpointAuthorization: { authorize: async (candidate) => new URL(candidate.href) },
  });

  await client.connect();
  assert.equal(client.negotiatedServer?.protocolEra, "legacy");
  assert.equal(client.negotiatedServer?.protocolVersion, "2025-11-25");
  assert.equal(client.negotiatedServer?.serverName, "alfred-legacy-test");

  const catalog = await client.refreshCatalog();
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

function writeJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
}
