# VS Code MCP client patterns relevant to Alfred issue #540

Status: researched 2026-07-22  
Scope: official `microsoft/vscode` source and official VS Code documentation; comparison with
[`mcp-raw-client-v1-requirements.md`](./mcp-raw-client-v1-requirements.md),
[`mcp-ambiguous-write-outcomes.md`](./mcp-ambiguous-write-outcomes.md), and
[issue #540](https://github.com/99Yash/alfred/issues/540).  
Source snapshot: VS Code commit
[`bc3ab215d2c91fd4a78885d53e04c59a70b04c06`](https://github.com/microsoft/vscode/tree/bc3ab215d2c91fd4a78885d53e04c59a70b04c06).

## Conclusion

VS Code contains several good host patterns for configuration identity, lifecycle, discovery,
trust, credential custody, result provenance, observability, and test seams. Those patterns mostly
validate issue #540 rather than replacing its design. Alfred's immutable catalog revisions,
descriptor-bound policy, closed `mcp.call` projection, and durable ambiguous-operation ledger are
stronger fits for a multi-tenant hosted agent than VS Code's mutable machine cache and editor-scoped
approval state.

The most important source finding is a **negative** one. VS Code's `McpTool._callWithProgress()`
automatically repeats the same `tools/call` once when the connection enters an error state with
`shouldRetry`. The retry occurs inside the tool implementation and has no effect classification,
remote idempotency key, durable operation ledger, or reconciliation check
([source](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/contrib/mcp/common/mcpServer.ts#L1364-L1412)).
VS Code source therefore does **not** supply a safe solution to the ambiguous-write problem. Alfred
must explicitly prohibit transparent same-call retries after `delivery_possible`, including retries
hidden in a transport, connection manager, auth wrapper, or SDK.

## Reusable host patterns

### Configuration facts, runtime objects, and policy are separate

VS Code discovers serializable server definitions through collections, resolves variables and trust,
then creates a live `McpServerConnection` through a host delegate. The connection owns a launch/transport,
observable connection state, and initialized request handler; disposing it tears down the live state
([registry resolution](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/contrib/mcp/common/mcpRegistry.ts#L487-L544),
[connection lifecycle](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/contrib/mcp/common/mcpServerConnection.ts#L20-L139)).
Official documentation similarly describes `mcp.json` as the server configuration surface while
enablement, start/stop/restart, logs, and cached-tool reset are management operations
([add and manage MCP servers](https://code.visualstudio.com/docs/agent-customization/mcp-servers),
[configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)).

This supports #540's split between durable `mcp_connections` facts and process-local raw-client
objects. The reusable invariant is that serialized configuration is not a live session and runtime
state is reconstructible. VS Code's extension activation, local/remote extension hosts, workspace
folders, command palette, and process launch delegates are desktop machinery and should not be copied.

VS Code also evaluates allow/deny policy once against the definition and again after variable
substitution against the resolved launch identity; if policy later blocks a live server, it disposes
the connection and suppresses its cached tools
([resolved-identity policy](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/contrib/mcp/common/mcpServer.ts#L408-L439),
[pre/post-resolution checks](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/contrib/mcp/common/mcpServer.ts#L722-L821)).
For Alfred, the equivalent is to authorize the stored endpoint/connection, then re-check the pinned,
fully resolved origin immediately before use. This is already consistent with the requirements and
#540's server-resolved ledger identity.

### Configuration-change trust is bound to a nonce

For server sources configured as `TrustedOnNonce`, VS Code stores the nonce at which the user trusted
the definition. An unchanged nonce bypasses another prompt; a changed nonce requires renewed trust
unless the user explicitly initiated an auto-trusting edit
([trust check](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/contrib/mcp/common/mcpRegistry.ts#L214-L304)).
This is a useful general pattern: trust is an assertion about a particular configuration version, not
a timeless boolean about a display name.

Issue #540 already applies the stronger tool-level version of this pattern by binding reviewed policy
and approvals to connection, remote tool, descriptor hash, and policy/catalog revision. A later
connection-management slice should likewise bind server-start trust to a canonical connection/config
hash. Workspace trust prompts and grouped editor dialogs are VS Code-specific UI.

### Cached discovery has explicit freshness state

VS Code persists a bounded LRU of tools, prompts, capabilities, server metadata, and the trust nonce in
machine-scoped storage so tools can be shown before a server starts
([metadata cache](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/contrib/mcp/common/mcpServer.ts#L116-L217)).
It compares the cached nonce with the current definition nonce and exposes `Unknown`, `Cached`,
`Outdated`, refreshing, and `Live` states instead of treating every cached value as current authority
([cache state](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/contrib/mcp/common/mcpServer.ts#L462-L493)).
On `notifications/tools/list_changed`, it refetches tools, validates them, and updates observers
([refresh path](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/contrib/mcp/common/mcpServer.ts#L1157-L1231)).

The request handler correctly follows cursors until `nextCursor` is absent
([pagination](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/contrib/mcp/common/mcpServerRequestHandler.ts#L257-L280)).
However, its refresh publishes into a mutable last-known cache rather than an append-only authority
history. Alfred should retain #540's all-pages-validated, atomically published immutable revisions and
bounded `mcp.list_tools`. VS Code's explicit freshness vocabulary is useful for operator/UI status, but
must not weaken the rule that an approval executes only against its exact descriptor revision.

### Tool identity preserves source provenance, but display aliases are lossy

VS Code's general tool source key includes `collectionId` and `definitionId`, while MCP tools are
registered with their source metadata. Its model-facing tool ID is a normalized, collision-resolved,
length-capped prefix plus remote name; dots and invalid characters are rewritten
([source key](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/contrib/chat/common/tools/languageModelToolsService.ts#L109-L146),
[MCP prefix generation](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/contrib/mcp/common/mcpServer.ts#L220-L258),
[tool construction](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/contrib/mcp/common/mcpServer.ts#L1331-L1362)).

The provenance pattern is reusable; the lossy ID is not suitable as durable authority. #540's fixed
closed `mcp.call` plus `{ connectionId, remoteName, catalogRevision }` argument is safer and avoids
widening Alfred's built-in tool-name union. Human aliases should remain search/display only.

### Server trust, pre-execution approval, and post-result approval are distinct

VS Code separates permission to start a server from permission to invoke a tool. It can also request
post-execution confirmation before an open-world result reaches the model. The MCP contribution maps
`readOnlyHint` to whether pre-approval may be requested and `openWorldHint` to post-result approval
([tool registration](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/contrib/mcp/common/mcpLanguageModelToolContribution.ts#L136-L160),
[confirmation preparation](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/contrib/mcp/common/mcpLanguageModelToolContribution.ts#L213-L263),
[approval documentation](https://code.visualstudio.com/docs/agents/approvals)).

The separation is reusable: connection trust must not grant write authority, and inbound untrusted
result review is different from outbound mutation approval. But VS Code's direct use of server-supplied
annotations is inappropriate for Alfred's authoritative policy. #540 is correct to default
`effect_class=unknown`, `retry_contract=never`, and require reviewed host policy for downgrades.
A future result-hardening slice may add an independent post-result gate for prompt-injection-sensitive
open-world output; it is not needed to implement #540's write barrier.

### Credentials are resolved outside shared configuration and redacted in logs

VS Code keeps secret input values encrypted at rest using an AES-GCM key held by the platform secret
store, while non-secret resolved values use ordinary scoped storage
([input storage](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/contrib/mcp/common/mcpRegistryInputStorage.ts#L16-L176)).
For HTTP MCP, it discovers authorization metadata, obtains tokens through the authentication service,
adds them only as `Authorization: Bearer`, manually follows redirects, strips credential-bearing
headers on cross-origin redirects, and redacts authorization headers from trace logs
([token acquisition](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/api/common/extHostMcp.ts#L704-L783),
[redirect and log handling](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/api/common/extHostMcp.ts#L834-L924)).

This validates the requirements' credential-reference and hardened-fetch boundaries. The concrete VS
Code secret-storage, dynamic authentication-provider, and browser redirect machinery are desktop
implementation details. Alfred still needs its own server-side encrypted credential owner, SSRF policy,
audience/resource binding, and atomic token rotation in the later OAuth slice.

### Preserve protocol result structure and provenance

VS Code records input/output details separately from model-facing content, preserves `isError`, honors
content audience, handles text/image/audio/embedded-resource/resource-link variants, and prefers
`structuredContent` over duplicate text for the model. It retains the raw MCP result for MCP App UI
rendering
([result mapping](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/contrib/mcp/common/mcpLanguageModelToolContribution.ts#L265-L400)).

Alfred should likewise keep a bounded validated protocol envelope distinct from its model rendering and
redacted audit view. It should not copy VS Code's eager desktop resource/image fetching; the requirements
correctly prohibit automatic resource-link fetches and require limits before persistence/model exposure.

### Trace context and diagnostics are worth carrying through the ledger

VS Code passes conversation/request IDs and W3C `traceparent`/`tracestate` in MCP `_meta`, scopes progress
notifications to a generated progress token, logs protocol messages per server, and emits server boot
state/capability telemetry
([tool-call metadata and retry path](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/contrib/mcp/common/mcpServer.ts#L1364-L1412),
[protocol logging](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/contrib/mcp/common/mcpServerRequestHandler.ts#L181-L218),
[monitoring documentation](https://code.visualstudio.com/docs/agents/guides/monitoring-agents),
[Chat Debug view](https://code.visualstudio.com/docs/agents/agent-troubleshooting/chat-debug-view)).

For Alfred, correlation should be host-owned metadata, never authority. Record connection, catalog and
descriptor revisions, operation-intent ID, staging/tool-call IDs, attempt phase transitions, redacted
failure class, and trace ID. An operator-safe timeline is especially useful when resolving `unknown`.
Do not place arguments, result bodies, tokens, or arbitrary server errors in metrics by default.

### Test the protocol boundary with deterministic transports

VS Code tests the connection and request handler using a controllable fake message transport that can
set state, emit messages, and capture outbound messages
([test transport](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/contrib/mcp/test/common/mcpRegistryTypes.ts#L25-L145),
[request-handler tests](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/contrib/mcp/test/common/mcpServerRequestHandler.test.ts)).
This reinforces #540's injected client/protocol factory and dispatch-level behavioral tests. Alfred's
tests must go further by asserting durable database state and restart recovery, which an in-memory
desktop connection test cannot prove.

## Cancellation, timeouts, and retries: do not copy VS Code

VS Code's request handler passes cancellation to its JSON-RPC layer and emits
`notifications/cancelled`; a launch failure cancels all local waiters
([request cancellation](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/contrib/mcp/common/mcpServerRequestHandler.ts#L200-L246)).
Despite a stale doc comment mentioning `timeoutMs`, the shown `sendRequest` signature has no timeout
argument. More importantly, neither cancellation nor connection state records whether a remote effect
occurred.

After `callTool` throws, `_callWithProgress` checks only `connectionState.shouldRetry` and recursively
calls itself once with identical arguments. There is no check of `readOnlyHint`, effect class, delivery
boundary, or server idempotency contract
([automatic retry](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/contrib/mcp/common/mcpServer.ts#L1380-L1412)).
Official Autopilot documentation also describes automatic retries on errors without documenting a
remote-write safety distinction
([approvals and Autopilot](https://code.visualstudio.com/docs/agents/approvals)).

This is acceptable only as evidence of VS Code's chosen UX, not as evidence of exactly-once or safe
retry semantics. A desktop process can show a local error and rely on a nearby user; Alfred is a durable
hosted agent whose model may keep proposing actions after the worker or session changes. The MCP and
HTTP constraints in Alfred's existing ambiguous-outcome research still govern.

VS Code also adopts a returned MCP Task and polls it to completion, with a task manager shared across
connection objects
([task-result adoption](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/contrib/mcp/common/mcpServerRequestHandler.ts#L510-L529),
[poll/reconnect loop](https://github.com/microsoft/vscode/blob/bc3ab215d2c91fd4a78885d53e04c59a70b04c06/src/vs/workbench/contrib/mcp/common/mcpServerRequestHandler.ts#L590-L732)).
That is useful only after the client has received the task ID, and VS Code's manager is not a durable
crash-recovery ledger. It does not close the lost-initial-response gap described in Alfred's ambiguous
write research. #540 is therefore right to reject task-required tools in v1 and defer durable Task
support.

## Concrete comparison with issue #540

### Keep unchanged

- Persist connection facts, not SDK objects; rehydrate a single live client lazily.
- Use a fixed closed `mcp.call`/`mcp.list_tools` projection and carry the external reference in arguments.
- Publish immutable catalog revisions atomically and bind approval/policy to the exact descriptor hash.
- Default remote annotations to untrusted hints, not authority.
- Keep risk, effect class, and retry contract separate.
- Persist `delivery_possible` before entering protocol/network code; unresolved rows block semantic repeats.
- Use bounded local discovery and test the behavior through `dispatchToolCall` with a fake protocol.
- Keep MCP credentials distinct from downstream provider grants and outside model/browser-visible state.

### Actionable clarifications for #540 or its implementation brief

1. **Prohibit transparent lower-layer retries.** State normatively that after `delivery_possible`, an
   effectful `tools/call` may not be retried inside the raw client, SDK, auth wrapper, connection manager,
   session-refresh path, or broker. A reconnect/session refresh may prepare a later authorized attempt;
   it may not replay the current call. This closes the exact hole visible in VS Code's helper.
2. **Add a reconnectable-error regression test.** Script a fake connection that marks itself
   retryable/expired after accepting the request. Assert exactly one outbound `tools/call`, ledger
   outcome `unknown`, and an identical fresh `tool_call_id` blocked. Timeout tests alone do not prove
   a connection manager will not hide a replay.
3. **Make connection/config trust versioned in the later management slice.** Bind permission to start a
   server to a canonical connection/config hash and re-check the fully resolved pinned origin before
   launch/use. This is separate from per-tool approval and descriptor-bound policy.
4. **Specify redacted trace fields.** The v1 ledger already has most correlation data; name the safe
   diagnostic fields and phase timestamps so an operator can reconstruct an ambiguous attempt without
   logging credentials or full payloads. This can be acceptance-level observability, not a new table.
5. **Preserve raw validated result vs model projection.** Make explicit that the broker envelope keeps
   protocol `isError`, structured content, and bounded content metadata independently of the sanitized
   model-facing representation. Do not auto-fetch returned links.

The first two are correctness changes for the issue's current offline slice. The last three are useful
precision or follow-up work. VS Code offers no reason to weaken #540's ambiguous-write barrier; its source
instead demonstrates why Alfred must enforce that barrier above and around every reconnect/retry helper.
