import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const PROTOCOL_VERSION = "2025-11-25";
const sessions = new Map();

const server = createServer(async (request, response) => {
  if (request.url !== "/mcp") {
    response.writeHead(404).end();
    return;
  }
  if (request.method === "GET") {
    // This small server does not offer a standalone SSE listener.
    response.writeHead(405).end();
    return;
  }
  if (request.method === "DELETE") {
    const sessionId = request.headers["mcp-session-id"];
    if (typeof sessionId === "string") sessions.delete(sessionId);
    response.writeHead(204).end();
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(405).end();
    return;
  }

  const accept = request.headers.accept ?? "";
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
    response.writeHead(406).end("Client must accept application/json and text/event-stream");
    return;
  }

  let message;
  try {
    message = JSON.parse(await readBody(request));
  } catch {
    jsonResponse(response, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }

  if (message.method === "initialize") {
    const sessionId = randomUUID();
    sessions.set(sessionId, { ready: false });
    jsonResponse(
      response,
      200,
      {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "http-calendar-lab", version: "1.0.0" },
        },
      },
      { "MCP-Session-Id": sessionId },
    );
    return;
  }

  const sessionId = request.headers["mcp-session-id"];
  const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
  if (!session || request.headers["mcp-protocol-version"] !== PROTOCOL_VERSION) {
    response.writeHead(400).end("Missing or invalid MCP session/version headers");
    return;
  }

  if (message.method === "notifications/initialized" && message.id === undefined) {
    session.ready = true;
    response.writeHead(202).end();
    return;
  }

  if (!session.ready) {
    jsonResponse(response, 400, {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32002, message: "Client has not completed initialization" },
    });
    return;
  }

  if (message.method === "tools/list") {
    jsonResponse(response, 200, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "calendar_reschedule_preview",
            description: "Preview a meeting reschedule without mutating a calendar.",
            inputSchema: {
              type: "object",
              properties: {
                eventTitle: { type: "string" },
                newStart: { type: "string", format: "date-time" },
              },
              required: ["eventTitle", "newStart"],
              additionalProperties: false,
            },
          },
        ],
      },
    });
    return;
  }

  jsonResponse(response, 200, {
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `Method not found: ${String(message.method)}` },
  });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
if (!address || typeof address === "string") throw new Error("Expected a TCP address");
const endpoint = `http://127.0.0.1:${address.port}/mcp`;

console.log(`REMOTE MCP SERVER\n${endpoint}\n`);

const initialize = await post({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "alfred-http-lab", version: "1.0.0" },
  },
});
const sessionId = initialize.headers.get("mcp-session-id");
if (!sessionId) throw new Error("Server did not return MCP-Session-Id");

await post(
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { sessionId, protocolVersion: PROTOCOL_VERSION },
);

await post(
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { sessionId, protocolVersion: PROTOCOL_VERSION },
);

console.log("ALFRED IS STILL ONLY THE MCP CLIENT");
console.log("It initiated every POST. It exposed no /mcp endpoint of its own.\n");

await fetch(endpoint, {
  method: "DELETE",
  headers: {
    "MCP-Session-Id": sessionId,
    "MCP-Protocol-Version": PROTOCOL_VERSION,
  },
});
await new Promise((resolve) => server.close(resolve));

async function post(message, session = {}) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(session.sessionId ? { "MCP-Session-Id": session.sessionId } : {}),
    ...(session.protocolVersion ? { "MCP-Protocol-Version": session.protocolVersion } : {}),
    // A production remote connection would also send:
    // Authorization: "Bearer <token-issued-for-this-MCP-server>"
  };
  console.log(`ALFRED MCP CLIENT → POST /mcp\nheaders=${pretty(headers)}\nbody=${pretty(message)}\n`);
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });
  const text = await response.text();
  console.log(
    `MCP SERVER → HTTP ${response.status}\nheaders=${pretty(Object.fromEntries(response.headers))}\nbody=${text || "<empty>"}\n`,
  );
  if (!response.ok) throw new Error(`MCP request failed: HTTP ${response.status}`);
  return { response, headers: response.headers, body: text ? JSON.parse(text) : null };
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Body too large");
  }
  return body;
}

function jsonResponse(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}
