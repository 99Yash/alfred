# MCP Real-World Wire Examples — 2025-11-25 and 2026-07-28

- **Status:** research note — primary sources only
- **Date:** 2026-08-23
- **Scope:** concrete JSON on the wire for capability disclosure, roots, sampling, elicitation/MRTR, tools, resources, version strings, headers, `ttlMs`/`cacheScope`. Sources: `modelcontextprotocol.io` spec, `github.com/modelcontextprotocol/specification` `schema.ts`, `github.com/modelcontextprotocol/typescript-sdk`, `github.com/modelcontextprotocol/servers` and `servers-archived`.

## Summary table

| Area                                | Wire shape                                                                                                                                         | Primary source                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocolVersion`                   | `"2025-11-25"`, `"2026-07-28"` strings                                                                                                             | [spec 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25) / [spec 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28), `LATEST_PROTOCOL_VERSION` in `schema.ts`                                                                                                  |
| `initialize` (legacy)               | `method: "initialize"` + `params.capabilities` + `clientInfo`; `result` carries `protocolVersion` + `capabilities` + `serverInfo` + `instructions` | [lifecycle 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)                                                                                                                                                                                                     |
| `server/discover` (modern)          | `method: "server/discover"` with per-request `_meta`; result has `supportedVersions`, `capabilities`, `instructions`, `ttlMs`, `cacheScope`        | [discover 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)                                                                                                                                                                                                      |
| Per-request `_meta`                 | `io.modelcontextprotocol/protocolVersion` (req), `clientCapabilities` (req), `clientInfo`, `logLevel`                                              | [basic `_meta` 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic)                                                                                                                                                                                                           |
| `roots`                             | `roots/list` direct (2025) vs `input_required` → `roots/list` (2026 MRTR)                                                                          | [roots 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/client/roots) / [roots 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/client/roots)                                                                                                                |
| `sampling`                          | `sampling/createMessage` with `messages`, `modelPreferences`, `maxTokens`, optional `tools`/`toolChoice`                                           | [sampling 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling)                                                                                                                                                                                                      |
| `elicitation` + MRTR                | `elicitation/create` `form` (`requestedSchema`) + `url` (`url`); 2026 wraps as `resultType: "input_required"`                                      | [elicitation 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation) / [elicitation 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation) + [MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr) |
| `tools/list` + `tools/call`         | descriptor `name`, `title`, `description`, `inputSchema`, `outputSchema`, `annotations`, `icons`, `x-mcp-header`                                   | [tools 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) / [tools 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)                                                                                                                |
| `resources/list` + `resources/read` | resource `uri`, `name`, `mimeType`, `annotations`; `contents` `text`/`blob`                                                                        | [resources 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)                                                                                                                                                                                                    |
| Headers                             | `MCP-Protocol-Version`, `Mcp-Session-Id` (legacy), `Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`                                                         | [transports 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) / [Streamable HTTP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)                                                                         |
| Caching                             | `ttlMs` (>=0), `cacheScope: "public" \| "private"`                                                                                                 | [schema 2026-07-28 `CacheableResult`](https://github.com/modelcontextprotocol/specification/blob/main/schema/2026-07-28/schema.ts)                                                                                                                                                                   |

---

## 1. Capability disclosure

### Spec definition

- **2025-11-25** handshake: client `initialize` carries `protocolVersion` + `capabilities` + `clientInfo`; server replies `protocolVersion` + `capabilities` + `serverInfo` + `instructions`; client sends `notifications/initialized`. Per-session negotiation. Source: [lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), [schema 2025-11-25](https://github.com/modelcontextprotocol/specification/blob/main/schema/2025-11-25/schema.ts) (`LATEST_PROTOCOL_VERSION = "2025-11-25"`).
- **2026-07-28** stateless: no `initialize`. Every request carries `_meta.io.modelcontextprotocol/protocolVersion` (required) + `clientCapabilities` (required). Server advertises via `server/discover`. Extensions via `capabilities.extensions`. Source: [versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning), [basic `_meta`](https://modelcontextprotocol.io/specification/2026-07-28/basic), [schema 2026-07-28](https://github.com/modelcontextprotocol/specification/blob/main/schema/2026-07-28/schema.ts) (`LATEST_PROTOCOL_VERSION = "2026-07-28"`).

### Real-world wire examples

**2025-11-25 `initialize` request (spec verbatim):**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-11-25",
    "capabilities": {
      "roots": { "listChanged": true },
      "sampling": {},
      "elicitation": { "form": {}, "url": {} },
      "tasks": {
        "requests": { "elicitation": { "create": {} }, "sampling": { "createMessage": {} } }
      }
    },
    "clientInfo": {
      "name": "ExampleClient",
      "title": "Example Client Display Name",
      "version": "1.0.0",
      "description": "An example MCP client application",
      "icons": [
        { "src": "https://example.com/icon.png", "mimeType": "image/png", "sizes": ["48x48"] }
      ],
      "websiteUrl": "https://example.com"
    }
  }
}
```

Source: [lifecycle init](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#initialization).

**2025-11-25 `initialize` response:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-11-25",
    "capabilities": {
      "logging": {},
      "prompts": { "listChanged": true },
      "resources": { "subscribe": true, "listChanged": true },
      "tools": { "listChanged": true },
      "tasks": { "list": {}, "cancel": {}, "requests": { "tools": { "call": {} } } }
    },
    "serverInfo": {
      "name": "ExampleServer",
      "title": "Example Server Display Name",
      "version": "1.0.0",
      "description": "An example MCP server providing tools and resources",
      "icons": [
        {
          "src": "https://example.com/server-icon.svg",
          "mimeType": "image/svg+xml",
          "sizes": ["any"]
        }
      ],
      "websiteUrl": "https://example.com/server"
    },
    "instructions": "Optional instructions for the client"
  }
}
```

**Real server capabilities:** `src/filesystem/index.ts` creates `McpServer({ name: "secure-filesystem-server", version: "0.2.0" })` — SDK derives `tools` automatically; it checks `getClientCapabilities()?.roots` and calls `listRoots()` on init. Source: [servers `src/filesystem/index.ts`](https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/index.ts) (main, npm `2026.7.10`, commit `d31124c`). Minimal wire capability: `{ "capabilities": { "tools": {} } }`. Github/slack archived servers use `new Server({ name: "github-mcp-server", version: VERSION }, { capabilities: { tools: {} } })`. Source: [servers-archived `src/github/index.ts`](https://github.com/modelcontextprotocol/servers-archived/blob/main/src/github/index.ts), [src/slack/index.ts](https://github.com/modelcontextprotocol/servers-archived/blob/main/src/slack/index.ts).

**2026-07-28 `server/discover` (request + response):**

```json
{
  "jsonrpc": "2.0",
  "id": "discover-1",
  "method": "server/discover",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "ExampleClient", "version": "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": "discover-1",
  "result": {
    "resultType": "complete",
    "supportedVersions": ["2026-07-28"],
    "capabilities": { "tools": {}, "resources": {} },
    "_meta": {
      "io.modelcontextprotocol/serverInfo": { "name": "ExampleServer", "version": "1.0.0" }
    },
    "instructions": "This server provides weather and resource utilities.",
    "ttlMs": 3600000,
    "cacheScope": "public"
  }
}
```

Source: [discover](https://modelcontextprotocol.io/specification/2026-07-28/server/discover).

**Per-request `_meta` (2026 `tools/call`):**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "get_weather",
    "arguments": { "location": "Seattle, WA" },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "ExampleClient", "version": "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

Source: [Streamable HTTP \_meta](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#request-metadata). Extensions: `{ "capabilities": { "tools": {}, "extensions": { "io.modelcontextprotocol/tasks": {} } } }` — [versioning extensions](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#extension-negotiation).

### Notes for Alfred (hosted vs local)

- 2025 `initialize` is per-process/session (`Mcp-Session-Id`). 2026 removes session — every request carries `protocolVersion` + `clientCapabilities`. Hosted Alfred over HTTP must not cache `initialize`; send `_meta` on every POST and expect stateless dispatch. See [statelessness](https://modelcontextprotocol.io/specification/2026-07-28/basic#statelessness).

---

## 2. `roots` capability

### Spec definition

- 2025: `capabilities.roots.listChanged`; server sends `roots/list` as server-initiated JSON-RPC. Source: [roots 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/client/roots).
- 2026: deprecated ([SEP-2577](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2577)), kept 12 months. Still `roots: {}` in `_meta.clientCapabilities`; server requests via MRTR `InputRequiredResult` containing `roots/list`. No `notifications/roots/list_changed` in modern flow. Source: [roots 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/client/roots).

### Real-world wire examples

**2025 `roots/list`:**

```json
{ "jsonrpc": "2.0", "id": 1, "method": "roots/list" }
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { "roots": [{ "uri": "file:///home/user/projects/myproject", "name": "My Project" }] }
}
```

Multiple: `[{ "uri": "file:///home/user/repos/frontend", "name": "Frontend Repository" }, { "uri": "file:///home/user/repos/backend", "name": "Backend Repository" }]`. Source: [roots 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/client/roots#protocol-messages).

**2026 MRTR:** inputRequest `{ "method": "roots/list" }` inside `result.inputRequests.<key>` with `resultType: "input_required"`; client returns `{ "roots": [{ "uri": "file:///home/user/projects/myproject", "name": "My Project" }] }` in `inputResponses`. Source: [roots 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/client/roots#protocol-messages).

**Capabilities:** 2025 `{ "capabilities": { "roots": { "listChanged": true } } }` in `initialize`; 2026 `{ "_meta": { "io.modelcontextprotocol/clientCapabilities": { "roots": {} } } }`.

**Real filesystem use:** on init if `clientCapabilities?.roots` then `server.server.listRoots()` and `getValidRootDirectories(roots)` replaces `allowedDirectories`; also handles `notifications/roots/list_changed`. Source: [filesystem `index.ts`](https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/index.ts).

### Notes for Alfred

- Local stdio sandbox: expose job dir as `file:///tmp/alfred-job/<id>` via roots. Hosted/stateless gateway: do not rely on roots — deprecated in 2026; pass dirs via tool args or resource URIs.

---

## 3. `sampling` capability

### Spec definition

Servers request completions via `sampling/createMessage`; clients declare `sampling: {}` or `sampling: { tools: {} }`. In 2026 deprecated (same SEP) but still in schema; modern form is MRTR inputRequest. Source: [sampling 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling), [schema 2026-07-28](https://github.com/modelcontextprotocol/specification/blob/main/schema/2026-07-28/schema.ts).

### Real-world wire examples

**Capabilities:** `{ "capabilities": { "sampling": {} } }` or `{ "capabilities": { "sampling": { "tools": {} } } }`; 2026 per-request `{ "_meta": { "io.modelcontextprotocol/clientCapabilities": { "sampling": { "tools": {} } } } }`.

**Basic request/response:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "sampling/createMessage",
  "params": {
    "messages": [
      { "role": "user", "content": { "type": "text", "text": "What is the capital of France?" } }
    ],
    "modelPreferences": {
      "hints": [{ "name": "claude-3-sonnet" }],
      "intelligencePriority": 0.8,
      "speedPriority": 0.5
    },
    "systemPrompt": "You are a helpful assistant.",
    "maxTokens": 100
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "role": "assistant",
    "content": { "type": "text", "text": "The capital of France is Paris." },
    "model": "claude-3-sonnet-20240307",
    "stopReason": "endTurn"
  }
}
```

Source: [sampling creating messages](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling#creating-messages).

**Tool-use variant (parallel `tool_use` + `tool_result` loop):**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "sampling/createMessage",
  "params": {
    "messages": [
      {
        "role": "user",
        "content": { "type": "text", "text": "What's the weather like in Paris and London?" }
      }
    ],
    "tools": [
      {
        "name": "get_weather",
        "description": "Get current weather for a city",
        "inputSchema": {
          "type": "object",
          "properties": { "city": { "type": "string" } },
          "required": ["city"]
        }
      }
    ],
    "toolChoice": { "mode": "auto" },
    "maxTokens": 1000
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "role": "assistant",
    "content": [
      {
        "type": "tool_use",
        "id": "call_abc123",
        "name": "get_weather",
        "input": { "city": "Paris" }
      },
      {
        "type": "tool_use",
        "id": "call_def456",
        "name": "get_weather",
        "input": { "city": "London" }
      }
    ],
    "model": "claude-3-sonnet-20240307",
    "stopReason": "toolUse"
  }
}
```

Follow-up merges `tool_result` blocks with `toolUseId` matching `id`. Source: [sampling with tools](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling#sampling-with-tools). In 2026 these objects live inside `InputRequiredResult.inputRequests`.

No filesystem/github/slack reference servers implement sampling (client feature).

### Notes for Alfred

- Gate sampling with user consent; each `sampling/createMessage` is a billable LLM call; MRTR can turn one `tools/call` into N round-trips — enforce caps.

---

## 4. `elicitation` + MRTR `input_required`

### Spec definition

Modes `form` (structured, `requestedSchema`) and `url` (out-of-band, `url`). Capability `elicitation: { form:{}, url:{} }` (2025 in `initialize`, 2026 in `_meta`). 2025: direct `elicitation/create` RPC; 2026: MRTR `resultType:"input_required"` with `inputRequests` map + `requestState` opaque blob; client retries with `inputResponses` + echoed `requestState`. Source: [elicitation 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation), [elicitation 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation), [MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr).

### Real-world wire examples

**2025 form request/response:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "elicitation/create",
  "params": {
    "mode": "form",
    "message": "Please provide your GitHub username",
    "requestedSchema": {
      "type": "object",
      "properties": { "name": { "type": "string" } },
      "required": ["name"]
    }
  }
}
```

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "action": "accept", "content": { "name": "octocat" } } }
```

Structured variant adds `email`/`age` with `format: "email"`, `minimum`. Source: [elicitation form 2025](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#form-mode-elicitation-requests).

**2025 url request:**

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "elicitation/create",
  "params": {
    "mode": "url",
    "elicitationId": "550e8400-e29b-41d4-a716-446655440000",
    "url": "https://mcp.example.com/ui/set_api_key",
    "message": "Please provide your API key to continue."
  }
}
```

Response `{ "result": { "action": "accept" } }` (out-of-band completes, then `notifications/elicitation/complete`). URL-required error `-32042` wraps `data.elicitations[0]` with same fields. Source: [elicitation url 2025](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#url-mode-elicitation-requests).

**2026 MRTR — inputRequired + retry:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "resultType": "input_required",
    "inputRequests": {
      "github_login": {
        "method": "elicitation/create",
        "params": {
          "mode": "form",
          "message": "Please provide your GitHub username",
          "requestedSchema": {
            "type": "object",
            "properties": { "name": { "type": "string" } },
            "required": ["name"]
          }
        }
      }
    },
    "requestState": "eyJsb2NhdGlvbiI6Ik5ldyBZb3JrIn0..."
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "get_weather",
    "arguments": { "location": "New York" },
    "inputResponses": { "github_login": { "action": "accept", "content": { "name": "octocat" } } },
    "requestState": "eyJsb2NhdGlvbiI6Ik5ldyBZb3JrIn0..."
  }
}
```

Source: [MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr#inputrequiredresult), [tools input_required](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#input-required-tool-results). Mixed `inputRequests` (elicitation + sampling) allowed; see MRTR core types.

2026 url inside MRTR omits `elicitationId` — `requestState` carries correlation: `{ "method":"elicitation/create","params":{ "mode":"url","url":"https://mcp.example.com/ui/set_api_key","message":"…" } }`.

### Notes for Alfred

- `requestState` must be AEAD/HMAC, bound to `sub` + TTL + request digest; treat as opaque on client. Derive user from `authorization` `sub`, not URL.

---

## 5. Tools (`tools/list` + `tools/call`)

### Spec definition

Servers declare `tools: { listChanged? }`. `tools/list` paginated + cacheable (2026); `tools/call` may return `InputRequiredResult`. Descriptor: `name`, `title`, `description`, `inputSchema` (2020-12), `outputSchema` (object root in 2025, any value in 2026), `annotations` (`readOnlyHint` etc.), `icons`, `x-mcp-header` (2026), `execution.taskSupport` deprecated. Source: [tools 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), [tools 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).

### Real-world wire examples

**Spec generic descriptors:**

```json
{
  "name": "get_weather",
  "title": "Weather Information Provider",
  "description": "Get current weather information for a location",
  "inputSchema": {
    "type": "object",
    "properties": { "location": { "type": "string" } },
    "required": ["location"]
  },
  "icons": [
    { "src": "https://example.com/weather-icon.png", "mimeType": "image/png", "sizes": ["48x48"] }
  ],
  "execution": { "taskSupport": "optional" }
}
```

Source: [tools 2025 listing](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#listing-tools).

**Filesystem `read_text_file` (real Zod → JSON Schema):**

```json
{
  "name": "read_text_file",
  "title": "Read Text File",
  "description": "Read the complete contents of a file from the file system as text. Handles various text encodings and provides detailed error messages if the file cannot be read. Use this tool when you need to examine the contents of a single file. Use the 'head' parameter to read only the first N lines of a file, or the 'tail' parameter to read only the last N lines of a file. Operates on the file as text regardless of extension. Only works within allowed directories.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path": { "type": "string" },
      "tail": {
        "type": "number",
        "description": "If provided, returns only the last N lines of the file"
      },
      "head": {
        "type": "number",
        "description": "If provided, returns only the first N lines of the file"
      }
    },
    "required": ["path"]
  },
  "outputSchema": { "type": "object", "properties": { "content": { "type": "string" } } },
  "annotations": { "readOnlyHint": true, "openWorldHint": false }
}
```

Source: [servers `src/filesystem/index.ts` lines 75-135](https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/index.ts) (npm 2026.7.10). `write_file` differs: `annotations: { readOnlyHint:false, idempotentHint:true, destructiveHint:true, openWorldHint:false }`.

**`tools/list` response:** 2025 `{ "tools": [ … ], "nextCursor":"…" }`; 2026 adds `resultType` + `ttlMs` + `cacheScope`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "resultType": "complete",
    "tools": [
      {
        "name": "get_weather",
        "title": "Weather Information Provider",
        "description": "Get current weather information for a location",
        "inputSchema": { "type": "object", "properties": { "location": { "type": "string" } } }
      }
    ],
    "nextCursor": "next-page-cursor",
    "ttlMs": 300000,
    "cacheScope": "public"
  }
}
```

Source: [tools 2026 listing](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#listing-tools).

**Github `create_issue` (archived):**

```json
{
  "name": "create_issue",
  "description": "Create a new issue in a GitHub repository",
  "inputSchema": {
    "type": "object",
    "properties": {
      "owner": { "type": "string" },
      "repo": { "type": "string" },
      "title": { "type": "string" },
      "body": { "type": "string" },
      "labels": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["owner", "repo", "title"]
  }
}
```

Source: [servers-archived `src/github/index.ts`](https://github.com/modelcontextprotocol/servers-archived/blob/main/src/github/index.ts) (`zodToJsonSchema(CreateIssueSchema)`).

**Slack `slack_post_message` (archived):**

```json
{
  "name": "slack_post_message",
  "description": "Post a new message to a Slack channel",
  "inputSchema": {
    "type": "object",
    "properties": {
      "channel_id": { "type": "string" },
      "text": { "type": "string" }
    },
    "required": ["channel_id", "text"]
  }
}
```

Source: [servers-archived `src/slack/index.ts`](https://github.com/modelcontextprotocol/servers-archived/blob/main/src/slack/index.ts).

**`tools/call` request/response:**

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": { "name": "get_weather", "arguments": { "location": "New York" } }
}
```

2025 response: `{ "result": { "content": [{ "type":"text","text":"Current weather in New York:\nTemperature: 72°F\nConditions: Partly cloudy" }], "isError": false } }` (no `resultType`).
2026: adds `"resultType":"complete"` + `structuredContent` when `outputSchema` present:

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "resultType": "complete",
    "content": [
      {
        "type": "text",
        "text": "{\"temperature\":22.5,\"conditions\":\"Partly cloudy\",\"humidity\":65}"
      }
    ],
    "structuredContent": { "temperature": 22.5, "conditions": "Partly cloudy", "humidity": 65 }
  }
}
```

Source: [tools calling 2025](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#calling-tools), [tools 2026](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).

**`x-mcp-header` tool (2026):**

```json
{
  "name": "execute_sql",
  "description": "Execute SQL on Google Cloud Spanner",
  "inputSchema": {
    "type": "object",
    "properties": {
      "region": { "type": "string", "x-mcp-header": "Region" },
      "query": { "type": "string" }
    },
    "required": ["region", "query"]
  }
}
```

Call mirrors `Mcp-Param-Region: us-west1`. Source: [tools x-mcp-header](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#x-mcp-header).

### Notes for Alfred

- Validate `tools/call` args against `inputSchema` client-side. Prefer `structuredContent` over parsing `content[0].text` when `outputSchema` exists. `isError:true` is still a successful JSON-RPC `result`.

---

## 6. Resources (`resources/list` + `resources/read`)

### Spec definition

`resources: { listChanged?, subscribe? }`. Both list/read cacheable in 2026; `resources/read` may return `InputRequiredResult`. Notifications via `subscriptions/listen`. Source: [resources 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/resources).

### Real-world wire examples

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "resources/list",
  "params": { "cursor": "optional-cursor-value" }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "resultType": "complete",
    "resources": [
      {
        "uri": "file:///project/src/main.rs",
        "name": "main.rs",
        "title": "Rust Software Application Main File",
        "description": "Primary application entry point",
        "mimeType": "text/x-rust",
        "icons": [
          {
            "src": "https://example.com/rust-file-icon.png",
            "mimeType": "image/png",
            "sizes": ["48x48"]
          }
        ]
      }
    ],
    "nextCursor": "next-page-cursor",
    "ttlMs": 300000,
    "cacheScope": "public"
  }
}
```

Resource with annotations: `{ "uri":"file:///project/README.md","name":"README.md","mimeType":"text/markdown","annotations":{ "audience":["user"],"priority":0.8,"lastModified":"2025-01-12T15:00:58Z" } }`.

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "resources/read",
  "params": { "uri": "file:///project/src/main.rs" }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "resultType": "complete",
    "contents": [
      {
        "uri": "file:///project/src/main.rs",
        "mimeType": "text/x-rust",
        "text": "fn main() {\n    println!(\"Hello world!\");\n}"
      }
    ],
    "ttlMs": 60000,
    "cacheScope": "private"
  }
}
```

Source: all from [resources 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/resources). Binary variant uses `blob` (base64). `resources/templates/list` adds `uriTemplate`. Filesystem reference server exposes no resources; `everything` server does.

### Notes for Alfred

- Share `cacheScope:"public"` across workspaces; keep `"private"` per token. Prefer tool `resource_link`/`resource` blocks over raw `resources/read`.

---

## 7. Version strings, headers, `ttlMs` / `cacheScope`

### Spec definition

- `protocolVersion` literals `"2025-11-25"` and `"2026-07-28"` (`LATEST_PROTOCOL_VERSION` in respective `schema.ts`).
- 2025: `Mcp-Session-Id` on `InitializeResult` + all POSTs; `MCP-Protocol-Version:<ver>` on all POSTs; `Accept: application/json, text/event-stream`.
- 2026: `MCP-Protocol-Version` must equal `_meta.protocolVersion` else `400 HeaderMismatch -32020`; `Mcp-Method`, `Mcp-Name`, `Mcp-Param-*` for `x-mcp-header`; no `Mcp-Session-Id`, no GET SSE.
- Caching: `ttlMs` (>=0, 0=stale), `cacheScope` on `DiscoverResult` / `ListToolsResult` / `ListResourcesResult` / `ReadResourceResult`.

### Real-world wire examples

```http
POST /mcp HTTP/1.1
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2025-11-25
Mcp-Session-Id: 1868a90c-1234-4abc-9def-111122223333
```

2025 `Mcp-Session-Id` minted in `InitializeResult` response header. Source: [transports 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management).

```http
POST /mcp HTTP/1.1
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: get_weather

{ "jsonrpc":"2.0","id":1,"method":"tools/call","params":{ "name":"get_weather","arguments":{ "location":"Seattle, WA" },"_meta":{ "io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{ "name":"ExampleClient","version":"1.0.0" },"io.modelcontextprotocol/clientCapabilities":{} } } }
```

Source: [Streamable HTTP 2026 headers](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#standard-request-headers). `Mcp-Name` for URIs: `file:///projects/myapp/config.json`. Non-ASCII → `Mcp-Param-Greeting: =?base64?SGVsbG8sIOS4lueVjA==?=` per [value encoding](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#value-encoding).

Errors: header mismatch → `400 { "error":{ "code":-32020,"message":"Header mismatch…" } }`; version mismatch → `400 { "error":{ "code":-32022,"data":{ "supported":["2026-07-28","2025-11-25"],"requested":"1900-01-01" } } }`. Source: [server validation](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#server-validation), [versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning).

Caching: `ttlMs:300000,cacheScope:"public"` on `tools/list`; `ttlMs:3600000` on `server/discover`; `ttlMs:60000,cacheScope:"private"` on `resources/read`. Source: [tools 2026](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), [discover](https://modelcontextprotocol.io/specification/2026-07-28/server/discover), [CacheableResult](https://github.com/modelcontextprotocol/specification/blob/main/schema/2026-07-28/schema.ts).

### Notes for Alfred

- Hosted gateway: mirror `Mcp-Method`/`Mcp-Name`/`Mcp-Param-*` for routing but validate vs body (`400 -32020`). No `Mcp-Session-Id` in 2026 — stateless LB. Local stdio: probe `server/discover` first, fall back to `initialize` on non-modern error per [stdio compat](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio#backward-compatibility). Treat `ttlMs:0` as no-cache.

---

## Sources

- Spec site `modelcontextprotocol.io` 2025-11-25: `/basic/lifecycle`, `/basic/transports`, `/client/roots`, `/client/sampling`, `/client/elicitation`, `/server/tools`, `/server/resources`.
- Spec site 2026-07-28: `/basic`, `/basic/versioning`, `/basic/patterns/mrtr`, `/basic/transports/streamable-http`, `/client/roots`, `/client/elicitation`, `/server/tools`, `/server/resources`, `/server/discover`, `/deprecated`.
- Spec repo `github.com/modelcontextprotocol/specification` `schema/2025-11-25/schema.ts` + `schema/2026-07-28/schema.ts` (`LATEST_PROTOCOL_VERSION`, `ClientCapabilities`, `ServerCapabilities`, `InputRequiredResult`, `CacheableResult`, `-32020`/`-32022`).
- Reference servers `github.com/modelcontextprotocol/servers` `src/filesystem/index.ts` (npm 2026.7.10, commit `d31124c`), `github.com/modelcontextprotocol/servers-archived` `src/github/index.ts`, `src/slack/index.ts`.
- TypeScript SDK `github.com/modelcontextprotocol/typescript-sdk` v2 (`2026-07-28`).

> All JSON blocks are copied or faithfully transcribed from the cited spec pages / source files. No JSON was invented; filesystem/github/slack `inputSchema` are `zodToJsonSchema` output as served.
