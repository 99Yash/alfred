# Raw MCP client and execution broker v1: implementation requirements

Status: researched 2026-07-21
Scope: hosted Alfred as an MCP client; Streamable HTTP, OAuth, and tools only
Version basis: MCP `2025-11-25`; `@modelcontextprotocol/sdk` `1.29.0`

## Conclusion

Alfred should use the official TypeScript SDK as a protocol codec and transport implementation, not as its trust boundary. The v1 production path should be:

```text
Alfred/agent code
  -> one Alfred-owned broker call
    -> input validation + policy + durable approval
      -> SDK Client.callTool()
        -> remote tools/call
      <- bounded, validated result
```

This is not redundant orchestration. The broker owns the decisions MCP deliberately does not: which user and connection may call a tool, whether the catalog is still the one that was approved, whether a write must park, how an uncertain write is reconciled, and how much untrusted result data may reach persistence or a model. The MCP specification explicitly leaves the interaction pattern to applications and recommends human visibility and denial/confirmation controls around tool invocations ([MCP tools: user interaction model](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#user-interaction-model)).

A server-side Code Mode endpoint is not a raw MCP surface. For example, Cloudflare documents that Code Mode replaces all upstream tool definitions with one `code` tool, and its search-and-execute form exposes only `search` and `execute` ([Cloudflare portal Code Mode](https://developers.cloudflare.com/changelog/post/2026-03-26-mcp-portal-code-mode/), [Cloudflare Code Mode patterns](https://developers.cloudflare.com/agents/model-context-protocol/codemode/)). At Alfred's MCP boundary, that is one opaque operation. Alfred cannot infer, authorize, approve, audit, or retry the operations performed inside it individually. Therefore:

- v1 admits servers only when `tools/list` exposes useful individual operations;
- a server-side `code`, `execute`, `agent`, or batch tool is treated as one opaque high-risk tool and is disabled by default;
- a codemode-only server is unsupported; the provider must offer a raw sibling endpoint or a switch that restores the individual tools;
- Alfred's own Code Mode or provider-native programmatic tool calling may compose raw broker calls, because every host tool invocation still returns to Alfred for enforcement.

## Required client profile

Advertise an empty client-capability object in v1. Do not advertise roots, sampling, elicitation, or Tasks. Require the server's `tools` capability and set the SDK's `enforceStrictCapabilities: true`; the SDK documents that strict remote-capability enforcement otherwise defaults to false for compatibility ([SDK `ProtocolOptions`](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/shared/protocol.ts)). Tasks are exposed by SDK 1.29.0 under an explicitly experimental API ([SDK client experimental API](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/client/index.ts#L297-L310)), so task-augmented tools should be rejected from v1 admission rather than silently taking a second execution path.

The admitted server must negotiate one of the SDK's supported protocol versions, but Alfred should initially require `2025-11-25` so one implementation is tested. Initialization must be the first protocol interaction, followed by `notifications/initialized`; normal calls cannot start before that handshake completes ([MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#initialization)). SDK `Client.connect()` performs this flow, rejects unsupported negotiated versions, records capabilities/server metadata, sets the HTTP protocol-version header, and sends the initialized notification ([SDK client initialization](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/client/index.ts#L483-L528)).

Use `StreamableHTTPClientTransport` only. Each JSON-RPC message is a POST to the single MCP endpoint with both `application/json` and `text/event-stream` accepted; the client must support a JSON response or an SSE response. Optional GET SSE is for server-originated messages, and SSE resumption uses `Last-Event-ID` ([MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)). Do not fall back to deprecated HTTP+SSE in v1.

## Connection and session lifecycle

For each active connection, the transport manager must own exactly one SDK `Client` and transport at a time. The state machine is:

```text
disconnected
  -> connecting/authenticating
  -> initialize
  -> initialized
  -> cataloging
  -> ready
  -> stale | auth_required | failed | disconnected
```

Persist connection facts, not live SDK objects: canonical MCP resource URI, pinned endpoint/origin, selected authorization-server identity, credential reference, granted scopes, connection status, negotiated protocol version, server identity/capabilities, and the current immutable catalog revision.

If the initialization response supplies `MCP-Session-Id`, every subsequent POST, GET, and DELETE must carry it; all subsequent HTTP requests also carry the negotiated `MCP-Protocol-Version`. A server may expire the session and respond `404`, at which point the client must initialize a new session without the old ID ([MCP session and version headers](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management)). SDK 1.29.0 captures the session ID, adds both headers, and exposes `terminateSession()` ([SDK Streamable HTTP transport](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/client/streamableHttp.ts#L451-L668)), but its non-OK response path does not implement the specification's `404 -> new initialization` transition. Alfred must catch session-expiry 404, discard the old client/transport, and construct a fresh pair. Passing an old `sessionId` into `Client.connect()` skips initialization ([SDK reconnect behavior](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/client/index.ts#L483-L489)), so that shortcut is only valid for a known-live session.

On explicit disconnect/revoke, attempt `terminateSession()`, tolerate 405 as the protocol allows, close the transport, revoke/delete the MCP credential through its owner, and mark the connection unusable. A network disconnection is not cancellation; the protocol requires an explicit cancellation notification ([MCP Streamable HTTP disconnection](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#sending-messages-to-the-server)).

Every request needs both a normal timeout and a maximum total timeout. SDK request options support `AbortSignal`, per-request timeout, progress-resettable timeout, and a non-resettable maximum ([SDK request options](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/shared/protocol.ts)). On abort or timeout, SDK 1.29.0 removes the local waiter and sends `notifications/cancelled` ([SDK cancellation path](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/shared/protocol.ts#L1165-L1218)). Cancellation remains advisory: the receiver may ignore it or may already have completed, and late responses must be ignored ([MCP cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation#behavior-requirements)). Consequently, a timed-out write has an **unknown outcome**, not a safe retry signal.

## Catalog acquisition and change handling

`tools/list` is paginated. Fetch every page until `nextCursor` is absent, applying limits to page count, total tools, descriptor bytes, schema bytes/depth, and unique names ([MCP tool listing](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#listing-tools)). Build one canonical, immutable catalog snapshot and hash it only after every page has passed validation. Persist both the normalized descriptor and the original validated protocol fields needed for auditing.

If the server advertises `tools.listChanged`, register `notifications/tools/list_changed`. A notification is only an invalidation signal: refetch all pages, validate them, and atomically publish a new catalog revision. Do not mutate the active revision tool by tool. Any staged approval remains bound to its old descriptor hash and must be re-resolved/revalidated before execution. The server capability and notification are defined by the tools specification ([MCP list-changed notification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#list-changed-notification)).

Do not use SDK 1.29.0's automatic list-change refresh as the authoritative catalog loader. Its handler calls `listTools()` once and returns that page ([SDK list-change handler](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/client/index.ts#L270-L295)); `listTools()` itself makes one request and replaces its cached tool metadata with that result ([SDK `listTools`](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/client/index.ts#L802-L843)). With multiple pages, repeated calls therefore leave the SDK output-validator cache covering only the most recently fetched page. Alfred should own pagination and validators for the complete immutable snapshot.

Catalog identity must remain separate from Alfred's closed built-in `ToolName` union. The durable authority key should contain at least:

```ts
type ExternalToolRef = {
  kind: "mcp";
  connectionId: string;
  remoteName: string;
  catalogRevision: string;
};
```

Display aliases are not authority keys. Names are server-scoped and case-sensitive; the specification only recommends, rather than requires, its name length and character rules ([MCP tool names](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool-names)). Alfred should enforce a stricter local admitted-name grammar and reject collisions.

## Schema and result validation

Treat the catalog as untrusted protocol data. For each descriptor:

1. Validate the MCP shape.
2. Require a root object `inputSchema` and compile it with Alfred's selected JSON Schema validator.
3. Compile synchronously with network loading disabled; reject unresolved/external references in v1 rather than fetching schema URLs.
4. Bound descriptor/schema bytes, object depth, property count, regex size, and compile time.
5. Validate arguments without coercion before policy/approval and again after any approval edit.
6. If `outputSchema` exists, compile and validate `structuredContent` independently in Alfred.

MCP requires `inputSchema` to be a valid JSON Schema object and says clients should validate structured output when an output schema exists ([MCP tool data type and output schema](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool)). SDK 1.29.0's `ToolSchema` checks the root `type: "object"` shape but permits all other schema keywords as unknown fields ([SDK `ToolSchema`](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/types.ts#L1380-L1425)). Its `callTool()` validates returned `structuredContent` only when it has cached that tool's output schema ([SDK `callTool`](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/client/index.ts#L728-L784)). It does **not** compile or validate call arguments against the advertised `inputSchema`; `callTool()` forwards `params` directly. Alfred must therefore validate both input and output itself.

Preserve the distinction between JSON-RPC/protocol errors and tool execution errors (`isError: true`). Do not reinterpret an error result, empty content, or failed output validation as a successful empty answer. The specification defines the two error channels separately so models can sometimes correct tool-level failures ([MCP tool error handling](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#error-handling)).

Bound results before full persistence or model exposure. This includes JSON bodies, individual SSE events, text, base64 image/audio, embedded resources, resource links, `_meta`, error bodies, and logs. Enforce limits in the custom fetch/SSE path where possible, because validation after `response.json()` is already too late for memory exhaustion. Keep small validated results in the invocation envelope and put larger payloads behind Alfred object handles. Do not automatically fetch returned resource links in v1. The MCP schema itself warns that icon URLs should be same-domain/trusted and that SVG can contain executable JavaScript ([MCP schema: `Icon`](https://modelcontextprotocol.io/specification/2025-11-25/schema#icon)); apply the same untrusted-URL posture to all returned links.

## Tool annotations and risk policy

`readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` are hints, not authorization facts. The MCP specification says clients **must** consider tool annotations untrusted unless they come from trusted servers ([MCP tool annotations](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool)). Even a trusted server's annotation does not encode Alfred's user policy.

The safe v1 default is locally gated/high risk. Downgrading requires an Alfred-owned reviewed policy keyed by connection identity, remote tool name, descriptor hash, and policy revision. An annotation can improve labels/search or prompt a review, but cannot by itself make a tool read-only, non-destructive, or retryable.

Every invocation must independently pass:

- connection ownership and active status;
- exact active external-tool membership for the run;
- workflow/integration allowance;
- current catalog revision and descriptor hash;
- input validation;
- local risk policy and approval decision;
- invocation-key/idempotency rules;
- result validation and bounds.

Because base `tools/call` has no protocol idempotency key, Alfred's `invocationKey` only deduplicates its own dispatcher. It cannot prove a remote server did not apply a timed-out call. Never automatically retry a write unless a reviewed local policy establishes remote idempotency or a read-after-write reconciliation proves the outcome. An untrusted `idempotentHint` is insufficient.

## OAuth and credential custody

Require standards-conforming OAuth for protected remote servers. The authorization sequence is:

1. Receive a 401 challenge and parse `resource_metadata`, or fall back to the endpoint-specific then root RFC 9728 well-known URI.
2. Validate and fetch Protected Resource Metadata (PRM).
3. Select an allowed authorization server from `authorization_servers`.
4. Discover RFC 8414 and OpenID Connect metadata; MCP clients must support both mechanisms.
5. Use a pre-registered client or Client ID Metadata Document for the first slice; defer Dynamic Client Registration unless the chosen provider requires it.
6. Generate and persist one-time state and PKCE verifier, redirect the user, verify callback state and binding, exchange the code, and persist tokens through the credential owner.
7. Include the canonical MCP resource as `resource` in both authorization and token requests.

These discovery requirements come directly from MCP authorization ([protected-resource and authorization-server discovery](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#authorization-server-discovery)). `resource` is mandatory in both requests and should be the most specific canonical MCP server URI ([MCP resource parameter](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#resource-parameter-implementation)).

SDK 1.29.0 provides an `OAuthClientProvider` abstraction whose implementation owns client registration data, tokens, PKCE verifier, state generation, redirects, discovery caching, and credential invalidation ([SDK OAuth provider](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/client/auth.ts#L43-L216)). Alfred's provider must store only secret-manager/encrypted credential references in ordinary connection rows; OAuth tokens and verifiers must never enter model messages, Code Mode globals, tool arguments/results, logs, or browser-readable application state. The bearer token is for Alfred -> MCP server only; the MCP server's downstream Google/GitHub/etc. credential is a separate grant. MCP forbids token passthrough and requires audience binding ([MCP token handling](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#token-handling)).

Do not assume the SDK makes the flow compliant by default:

- The specification requires PKCE and says absence of `code_challenge_methods_supported` must cause refusal ([MCP authorization-code protection](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#authorization-code-protection)). SDK 1.29.0 rejects metadata only when that field is present and does not contain `S256`; absence passes ([SDK `startAuthorization`](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/client/auth.ts#L1111-L1163)). Alfred must add the stricter presence-and-S256 check.
- SDK `finishAuth()` accepts an authorization code; callback `state` verification is not part of that method. Alfred's callback route must resolve the exact pending flow and compare state before invoking it. MCP recommends state verification and exact registered redirect URIs ([MCP open-redirection protection](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#open-redirection)).
- SDK discovery falls back to legacy behavior when PRM is unavailable ([SDK OAuth server discovery](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/client/auth.ts#L1073-L1108)). Alfred v1 should reject that fallback and require PRM, which also ensures the resource indicator is available.
- SDK accepts a custom `fetch`; use it for all MCP and OAuth traffic. Its normal discovery functions call the supplied fetch on metadata-derived URLs ([SDK metadata discovery](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/client/auth.ts#L750-L855), [SDK authorization-server discovery](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/client/auth.ts#L978-L1028)). Network policy must surround that fetch.

Send bearer tokens only in the `Authorization` header on every MCP HTTP request, never in a query string ([MCP access-token usage](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#access-token-usage)). Persist replacement access/refresh tokens atomically; public-client refresh tokens must rotate, and access tokens should be short-lived ([MCP token theft mitigations](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#token-theft)). Treat 403 `insufficient_scope` as a new user authorization event. Do not let an SDK retry silently widen authority inside an already-approved tool invocation; park/reconnect, record the new grant, then re-run policy against the original proposal. The protocol recommends bounded step-up retries ([MCP step-up authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#step-up-authorization-flow)).

## SSRF, redirects, and URL policy

All URLs supplied by a user or remote server are untrusted: MCP endpoint, `resource_metadata`, authorization-server identities, authorization/token/registration endpoints, icons, and result links. MCP's security guidance names metadata endpoints, private/link-local ranges, DNS rebinding, and redirect chains as SSRF vectors. It recommends HTTPS, blocking private/reserved addresses, validating every redirect hop, disabling blind automatic redirects, and considering DNS pinning/egress policy ([MCP SSRF guidance](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices#server-side-request-forgery-ssrf)).

The production fetch wrapper must therefore:

- require HTTPS (with no production loopback exception);
- reject URL credentials, fragments where forbidden, non-canonical ports, and dangerous schemes;
- resolve every hostname and reject private, loopback, link-local, multicast, reserved, and cloud-metadata destinations for both IPv4 and IPv6;
- prevent DNS rebinding with connection-time verification/pinning or an egress proxy;
- use `redirect: "manual"`, validate and resolve every hop, cap hops, and reconstruct allowed headers per destination;
- never forward `Authorization`, cookies, client secrets, or MCP session headers to a redirect target merely because `fetch` followed it;
- pin the MCP endpoint/resource identity after connection and disallow model-selected URLs or headers;
- apply response byte/time limits before parsing, including metadata and OAuth error bodies;
- validate authorization URLs before opening them and use a non-shell browser redirect path.

MCP specifically requires clients to allow only HTTP/HTTPS authorization URLs (HTTP only for local development), reject dangerous schemes, and never use shell commands to open them ([MCP OAuth URL validation](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices#oauth-authorization-url-validation)).

## Provider-native programmatic calling and durable approvals

Provider-native programmatic tool calling can be a useful adapter to the same broker. Anthropic's current flow lets code in a provider container call a client tool; each such call pauses code execution and returns a `tool_use` block to the client, which supplies the result before execution continues. Intermediate results can stay outside model context ([Anthropic programmatic tool-calling flow](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling#how-programmatic-tool-calling-works)). Expose one Alfred client tool such as `mcp_call({ ref, arguments })`; every invocation goes through the normal broker and therefore retains per-operation visibility.

Two constraints are decisive:

1. Anthropic says `allowed_callers` is guidance, not a hard API security boundary, so Alfred must still reject any caller/path not permitted by runtime policy ([Anthropic `allowed_callers`](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling#the-allowed-callers-field)).
2. The paused continuation requires the same container ID and tool definitions. Idle containers are currently reclaimed after about five minutes, while a pending programmatic call times out after about four minutes ([Anthropic container lifecycle](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling#container-lifecycle)). This is incompatible with Alfred approvals that may park for minutes, hours, or days.

Therefore provider-hosted code must not remain suspended across a durable human approval. Use one of these shapes:

- **Fast path:** reads and already-authorized low-risk calls return within the provider's continuation window.
- **Plan/apply path:** the programmatic call returns a durable approval proposal/handle rather than executing the write. Alfred parks its own run. After approval, a new durable step revalidates connection, catalog revision, schema, arguments, and policy, executes through the broker, and starts a fresh model/provider turn with the observed result.
- **Alfred Code Mode path:** prefer Alfred-owned code execution when the runtime can checkpoint/replay its own program state safely and every host call still crosses the broker.

Do not promise transparent replay of arbitrary model-written code after approval: reads before the pause may have changed, code may be nondeterministic, and a remote write may have an unknown outcome. Durable state is the proposal, descriptor/catalog hash, canonical arguments, approval, invocation state, and observed result—not a claim that an expired provider container can resume.

## Codemode-only server admission

The visibility rule is mechanical: Alfred can enforce per-operation policy only for operations represented as separate broker invocations. MCP transmits the name and arguments of the selected tool in one `tools/call` and returns one result ([MCP calling tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#calling-tools)). If that tool accepts source code and internally calls ten APIs, those ten calls are not MCP `tools/call` operations visible to Alfred.

Cloudflare's implementation makes the trade-off explicit: Code Mode advertises one `code` tool instead of each upstream tool, and the generated JavaScript composes upstream operations in its isolated Worker ([Cloudflare single-code-tool pattern](https://developers.cloudflare.com/agents/model-context-protocol/codemode/#single-code-tool)). Cloudflare also correctly says authorization and approvals must still be enforced inside the upstream handlers or host request callback ([Cloudflare sandbox and authorization boundary](https://developers.cloudflare.com/agents/model-context-protocol/codemode/#sandbox-and-authorization-boundary)). That can protect Cloudflare's boundary, but it does not give Alfred independent per-sub-operation evidence.

For v1 admission, require one of:

- a raw MCP endpoint whose `tools/list` returns the individual operations;
- a provider setting that disables server-side Code Mode and restores those tools (Cloudflare portals document such a switch); or
- an Alfred-reviewed exception treating the entire opaque call as one high-risk operation, with no claim of per-operation approval, idempotency, audit, or replay safety.

The exception should not be enabled for generic model-authored writes. It may later be reasonable for a narrowly scoped, server-enforced read-only aggregate where the whole operation and its data exposure are acceptable.

## Minimal v1 interfaces

Keep transport details out of runtimes:

```ts
interface McpTransportClient {
  connect(connection: McpConnection): Promise<McpNegotiatedConnection>;
  listAllTools(signal: AbortSignal): Promise<readonly McpToolDescriptor[]>;
  callTool(input: {
    name: string;
    arguments: unknown;
    signal: AbortSignal;
  }): Promise<unknown>;
  disconnect(): Promise<void>;
}

interface McpExecutionBroker {
  listTools(input: {
    actorId: string;
    connectionId: string;
    catalogRevision?: string;
  }): Promise<McpCatalogView>;

  callTool(input: {
    actorId: string;
    runId: string;
    ref: ExternalToolRef;
    arguments: unknown;
    invocationKey: string;
  }): Promise<McpCallEnvelope | McpApprovalInterrupt>;
}
```

The runtime never receives endpoint URLs, bearer tokens, arbitrary headers, the SDK client, or an unrestricted fetch function. The transport never decides approval. The broker never interprets a remote server's code/agent tool as a set of hidden capabilities.

## Implementation acceptance tests

The first vertical slice is not complete until automated tests cover:

- successful initialize/initialized negotiation and rejection of the wrong protocol version or missing `tools` capability;
- JSON and SSE responses, protocol/session headers, explicit close, session-expiry 404 reinitialization, bounded reconnect, and `Last-Event-ID` resumption;
- full multi-page catalog loading, duplicate-name rejection, atomic list-changed revision replacement, and approval invalidation on descriptor change;
- malformed descriptors, invalid/uncompilable schemas, external `$ref`, oversized/deep schemas, invalid input before staging, invalid approval-edited input, and invalid/missing structured output;
- `isError` preservation, JSON-RPC error preservation, oversized JSON/SSE/base64/error bodies, and large-result object handles;
- timeout/abort cancellation, late response races, and a timed-out write recorded as unknown rather than retried;
- PRM discovery from challenge and both well-known locations, RFC 8414 and OIDC discovery, mandatory S256 metadata, state mismatch, exact redirect URI, resource on authorization/token/refresh, refresh rotation, step-up parking, and revocation;
- SSRF attempts through endpoint, PRM, authorization-server metadata, token endpoint, DNS rebinding, IPv4-mapped IPv6, and every redirect hop, including proof that credentials never cross origins;
- annotations never downgrade risk without reviewed local policy;
- a raw read and gated write through the same broker;
- an opaque Code Mode server rejected by admission;
- provider-native programmatic calls visible one by one, plus an approval delay that expires the provider container and succeeds through Alfred's plan/apply continuation instead.

## Recommended build order

1. Hardened fetch/URL policy and OAuth credential provider.
2. Transport manager with lifecycle/session/cancellation tests against a deterministic fake Streamable HTTP server.
3. Full catalog loader, immutable revision hashing, schema compiler, and list-change refresh.
4. External-tool contracts and persistence, kept separate from built-in tool unions.
5. Execution broker integrated with existing active-tool, workflow, approval, invocation, and result-handle paths.
6. Alfred Code Mode binding (`mcp.call`) first; provider-native programmatic adapter only after the plan/apply approval split is proven.
7. One real raw-tool server vertical slice with both a read and a sandboxed/reversible write.

This order makes the raw endpoint usable before adding any model-facing projection and prevents a provider Code Mode experiment from becoming Alfred's credential or policy boundary.
