# Alfred MCP client — raw transport and execution-broker decision map

Status: bootstrap scoped 2026-07-21
Extends: ADR-0018, ADR-0053, ADR-0074, ADR-0087
Input: `.handoff/2026-07-21T073921Z.md` and the three MCP trust-boundary lessons

Implementation note (2026-07-21): the first transport/catalog slice now lives in
`packages/api/src/modules/mcp/`, with a real local Streamable HTTP integration
test. It implements the model-agnostic client described in #1/#3: strict
2025-11-25 negotiation, tools-only capability admission, full pagination,
immutable catalog revisions, input/output schema validation, list-change
invalidation, session-expiry handling, and bounded results. It does **not** yet
implement persisted connections/OAuth, the durable execution broker, approval
integration, or a Code Mode binding. Primary-source implementation constraints
are captured in `docs/research/mcp-raw-client-v1-requirements.md`.

## Working rule

**Do not stack orchestration layers.** Alfred should consume the lowest-level useful MCP surface a server offers: negotiated lifecycle, catalog discovery, and individual `tools/call` operations. Alfred's Code Mode (or a model provider's native programmatic tool calling) owns composition. A remote server's own code/agent/orchestration tool is an opaque capability, not the default integration path.

The intended split is:

```text
model-owned composition
  -> Alfred Code Mode or provider-native programmatic tool calling
    -> Alfred MCP execution broker
      -> raw MCP client (initialize, tools/list, tools/call)
        -> remote MCP server
```

The broker is not an extra agent layer. It is Alfred's trust boundary: connection ownership, credential custody, catalog revision checks, validation, policy, approval, durable call identity, result sanitation, and size bounds.

### Why not `@ai-sdk/mcp` as the client boundary?

AI SDK's [`createMCPClient`](https://ai-sdk.dev/docs/reference/ai-sdk-core/create-mcp-client) is a useful convenience adapter for turning an MCP server's tools into directly executable AI SDK tools. It is not Alfred's source of authority:

- its `tools()` convenience path fetches one `tools/list` page rather than constructing a bounded, atomic all-page catalog;
- it does not accept server notifications, so it cannot invalidate authority on `notifications/tools/list_changed`;
- its generated tool `execute` function calls the remote server directly instead of crossing Alfred's policy, approval, durability, and result-handling boundary;
- automatic schema conversion does not enforce the server-declared output schema, and it does not apply Alfred's descriptor/schema complexity limits;
- it supports a broader MCP feature and protocol surface than Alfred's deliberately narrow tools-only 2025-11-25 profile.

Alfred may reuse AI SDK schema/tool primitives in a runtime adapter after a tool has passed through the broker. It must not expose `createMCPClient().tools()` directly to a model or use that generated `execute` path for authoritative calls. The current behavior is visible in AI SDK's [MCP client implementation](https://github.com/vercel/ai/blob/main/packages/mcp/src/tool/mcp-client.ts).

## #1: What Is The Product Abstraction?

Blocked by: none
Type: Discuss

### Question

Should an MCP connection primarily import remote tools into Alfred's model-facing registry, or should it primarily expose a raw client/broker interface that different runtimes can adapt?

### Answer

**Raw client/broker first; model-facing projection second.** Split the implementation into three layers:

1. `McpTransportClient`: model-agnostic protocol lifecycle and transport.
2. `McpExecutionBroker`: Alfred-owned authorization, validation, approval, durability, and result handling.
3. Runtime adapters:
   - Alfred `code.run`: an injected `broker.mcp.call(ref, args)` host function.
   - Provider-native programmatic tool calling: one Alfred-executed client tool that routes into the same broker.
   - Direct model tools: optional projection of selected remote tools for models or workflows that do not use Code Mode.

ADR-0018's statement that imported tools simply become ordinary registry tools is too narrow. The registry projection is a compatibility view, not the source of truth.

## #2: What Counts As A Usable Server Surface?

Blocked by: #1
Type: Discuss

### Question

How should Alfred handle an MCP server that exposes its own Code Mode, agent, batch executor, or other orchestration tool?

### Answer

For v1, a server qualifies only if it exposes useful **raw, individually callable tools** through `tools/list` and `tools/call`.

- Prefer individual operations that preserve Alfred's per-call policy and approval visibility.
- Treat a server-side `execute_code`, `agent`, `batch`, or equivalent tool as one opaque remote tool.
- Do not call that opaque tool from Alfred Code Mode by default. That would create Code Mode -> Code Mode nesting while hiding the underlying operations from Alfred.
- A codemode-only server is **unsupported in v1**. Ask the provider for a raw MCP tool surface rather than building an Alfred-specific unwrap layer.
- A reviewed workflow may opt into an opaque orchestration tool later, but the whole call defaults to high risk and Alfred cannot claim per-sub-operation approval, idempotency, or replay safety.

This is also a provider-selection criterion for the first vertical slice.

## #3: What Is The Raw Alfred Interface?

Blocked by: #1
Type: Prototype

### Question

What is the smallest internal endpoint that lets Code Mode use MCP without importing another orchestration layer?

### Answer

Prototype an internal service interface, not a public inbound `/mcp` server:

```ts
interface McpExecutionBroker {
  listTools(input: {
    connectionId: string;
    catalogRevision?: string;
  }): Promise<McpCatalogView>;

  callTool(input: {
    connectionId: string;
    toolName: string;
    arguments: unknown;
    expectedCatalogRevision: string;
    invocationKey: string;
  }): Promise<McpCallEnvelope>;
}
```

The Code Mode binding should be a thin host function such as `broker.mcp.call(ref, args)`. It must cross IPC back into the trusted API process; the isolate never receives OAuth tokens, an unrestricted URL, arbitrary headers, or direct network access.

For provider-native programmatic calling, project the same broker call as an Alfred-executed client tool. Do not hand the provider an MCP connector that would move execution, credentials, or approval decisions outside Alfred's dispatcher.

Open prototype questions:

- How the current provider API represents code-only callers without giving the model a second direct-call path.
- Whether generated typed facades improve code reliability enough to justify them over `call(ref, args)` plus a catalog object.
- How a paused provider-hosted code container composes with Alfred's durable approval interrupt and later resume.

## #4: What Is The Durable Capability Identity?

Blocked by: #1, #3
Type: Prototype

### Question

How can an open-ended MCP catalog fit Alfred's closed `IntegrationSlug` / `ToolName` contracts without weakening built-in exhaustiveness?

### Answer

Do **not** widen the built-in unions to arbitrary strings. Introduce a separate validated identity:

```ts
type ExternalToolRef = {
  kind: "mcp";
  connectionId: string;
  remoteName: string;
  catalogRevision: string;
};
```

Persist and authorize the full identity. Human-friendly names such as `mcp:<connection-slug>:<remote-name>` are display/search aliases only; they are not durable authority keys.

An approval and retry key must bind at least:

- user and connection identity;
- pinned MCP server origin/resource;
- remote tool name;
- catalog revision or descriptor hash;
- canonical arguments hash;
- Alfred risk-policy revision.

If the catalog changes between proposal and execution, re-resolve and revalidate; never silently execute against a new schema or meaning.

## #5: Where Does Trust Live?

Blocked by: #3, #4
Type: Research

### Question

Which deterministic controls must surround the raw client?

### Answer

The v1 floor is:

- Treat server metadata, schemas, annotations, content blocks, URLs, errors, and results as untrusted protocol data.
- Validate tool arguments against the exact imported JSON Schema before staging and again after an approval edit. Do not add silent coercion to generic imported tools.
- Treat MCP tool annotations as UX/search hints only. Missing or unreviewed risk metadata defaults to gated/high risk; a local reviewed policy is required to downgrade it.
- Keep active-tool/workflow checks. Code Mode may loop over a catalog, but every underlying broker call must be authorized independently.
- Sanitize and bound every result before persistence or model exposure. Large results park behind ADR-0087 object handles; they do not become giant MCP content blocks in the transcript.
- Preserve MCP structured content and explicit error state in Alfred's envelope; never turn an error or suspicious empty response into a confident zero.
- Keep MCP-server OAuth credentials separate from downstream provider credentials. Alfred stores only a secret-manager reference and sends tokens only to the pinned MCP resource origin.
- Include OAuth resource indicators, PKCE, state validation, exact redirect URIs, short-lived tokens/refresh rotation, and token audience binding.
- On connection setup and every redirect/reconnect, enforce HTTPS, revalidate the destination against SSRF/private-network policy, pin the origin, disallow credentials in URLs, and disallow model-selected headers.
- Do not enable server-to-client sampling, roots, or elicitation in v1. Long-running MCP Tasks remain deferred while the capability is experimental.

Primary references: [MCP tool schema and annotations](https://modelcontextprotocol.io/specification/2025-11-25/schema), [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), and [MCP tool-annotation guidance](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/).

## #6: What Transport And Lifecycle Ship In V1?

Blocked by: #5
Type: Discuss

### Question

Which MCP protocol surface is justified for hosted Alfred?

### Answer

Keep v1 deliberately narrow:

- Streamable HTTP only.
- `initialize` / `notifications/initialized`.
- paginated `tools/list` and `notifications/tools/list_changed`.
- `tools/call` plus cancellation/timeouts.
- OAuth for protected remote servers.
- Session/version header handling and bounded reconnect/backoff.
- Explicit disconnect/revoke.

Defer stdio, legacy HTTP+SSE transport, resources, prompts, roots, sampling, elicitation, and Tasks. Optional server capabilities are negotiated and ignored unless Alfred has a named workflow for them.

Persist connections separately from immutable catalog revisions. The connection stores owner, canonical resource/origin, auth/credential reference, negotiated protocol/capabilities, status, and revocation state. A catalog revision stores the raw validated descriptors and a stable hash. Do not use one mutable `capability_cache` blob as both history and current authority.

## #7: Which Runtime Path Is Preferred?

Blocked by: #3, #5, #6
Type: Discuss

### Question

When both Alfred Code Mode and model-provider-native programmatic calling exist, which one should consume the broker?

### Answer

Use a capability-selected adapter, never both in the same call chain:

1. Prefer Alfred Code Mode when data custody, object handles, cross-provider behavior, or plan-then-apply writes matter.
2. Prefer provider-native programmatic calling when its container semantics are acceptable and it can pause on Alfred-executed client tools without bypassing Alfred's broker.
3. Use direct projected tools only when the selected model/workflow lacks a code path or when a single curated call is clearer.

Provider-native programmatic tool calling demonstrates the desired shape: code can call client tools while intermediate results stay out of the model context. Alfred should supply the trusted client tool, not insert a second agent. See [Anthropic's programmatic tool-calling flow](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling).

The runtime capability map—not prompt intuition—selects one path. Telemetry records `runtime_adapter`, remote calls, model round trips, bytes returned/parked, approval waits, and failures so the claimed efficiency is measurable.

## #8: What Is The First Vertical Slice?

Blocked by: #2, #3, #4, #5, #6
Type: Prototype

### Question

Which real server and workflow prove the architecture without duplicating a large existing Alfred integration?

### Answer

Unresolved; this is the frontier.

Selection gates:

- remote Streamable HTTP with standards-compliant OAuth or a safely provisioned test credential;
- exposes raw, individually callable tools rather than only server-side Code Mode;
- at least one read tool and one write tool so approval behavior is exercised;
- stable test tenant/sandbox and deterministic cleanup;
- useful Alfred workflow not already better served by a native integration;
- schemas and outputs small enough to debug, with one deliberate large-result fixture for handle behavior.

The spike must trace:

```text
connect -> initialize -> tools/list -> catalog revision
  -> discover/select -> Code Mode broker call
  -> validate -> policy/approval -> tools/call
  -> sanitize/bound/park -> provenance -> resume
```

It must also prove catalog drift, token refresh, timeout/cancel, duplicate invocation, malformed schema/result, dishonest annotations, server error, suspicious empty result, and revocation.

## #9: What Must Change In The Existing Decision Record?

Blocked by: #8
Type: Discuss

### Question

How should ADR-0018 change after the vertical slice?

### Answer

Amend it only after #8 supplies evidence. Expected corrections:

- replace "imports their tool catalogs into its tool registry" with raw client + broker + optional adapters;
- remove hosted stdio and legacy SSE from v1;
- replace `trusted invokes freely` with locally reviewed, per-tool policy and pessimistic defaults;
- replace mutable `capability_cache` authority with revisioned catalogs;
- distinguish built-in `ToolName` from open-ended `ExternalToolRef`;
- make codemode-only servers unsupported by default;
- make object handles and the Code Mode host-function seam explicit;
- keep Alfred-as-MCP-server deferred—none of this requires an inbound `/mcp` endpoint.

## Exit Criteria

This map is ready to become an implementation PRD when #8 chooses a real server and the spike answers the three open questions in #3. Until then, building a generic importer would fossilize guesses about auth, schema quality, Code Mode resume, and server catalog behavior.
