import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { McpRawClient } from "../../src/modules/mcp";

let endpoint: URL;
let closeServer: (() => Promise<void>) | null = null;
const observedCalls: string[] = [];

before(async () => {
  const app = createMcpExpressApp();
  app.post("/mcp", async (req, res) => {
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
    // Stateless mode. The SDK documents it two ways — `sessionIdGenerator:
    // undefined` and omitting the key — but only omission typechecks under
    // `exactOptionalPropertyTypes`, since the option is declared `?: () => string`.
    // Same mode either way ("if not provided, session management is disabled").
    const transport = new StreamableHTTPServerTransport({});
    // See `SdkMcpProtocolClient.connect` — the SDK's transport classes widen
    // `sessionId` / `onclose` past what its own `Transport` interface declares,
    // so the class does not structurally satisfy the interface under this flag.
    await server.connect(transport as Transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
  });
  app.get("/mcp", (_req, res) => res.status(405).end());
  app.delete("/mcp", (_req, res) => res.status(405).end());

  const httpServer = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
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
  assert.equal(client.negotiatedServer?.protocolVersion, "2025-11-25");
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
  assert.deepEqual(result.result, {
    content: [{ type: "text", text: "raw, not nested Code Mode" }],
    structuredContent: { echoed: "raw, not nested Code Mode" },
  });
  await client.close();
});
