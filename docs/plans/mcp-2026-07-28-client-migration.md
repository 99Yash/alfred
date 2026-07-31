# MCP `2026-07-28` client migration

Status: in progress

Source: [`../research/mcp-2026-07-28-client-opportunities.md`](../research/mcp-2026-07-28-client-opportunities.md)

## Outcome

Alfred uses the official `@modelcontextprotocol/client@2.0.0` only at its
outbound protocol seam. It supports modern stateless MCP `2026-07-28` and
legacy `2025-11-25` fallback. Alfred continues to own catalog authority,
validation, approvals, invocation durability, and no-replay controls.

## Invariants

- Do not add an Alfred MCP server.
- Do not add `mcp-use` to the production dependency graph.
- Do not advertise Roots, Sampling, Elicitation, or Tasks.
- Do not let transport reconnect or OAuth recovery replay `tools/call`.
- Do not replace immutable full-catalog revisions with an SDK cache.
- Do not weaken endpoint authorization, descriptor hashing, schema bounds, or
  approval policy.

## Delivery sequence

### 1. Protocol adapter and era negotiation

Status: implemented

- Replace `@modelcontextprotocol/sdk@1.29.0` with
  `@modelcontextprotocol/client@2.0.0`.
- Enable automatic modern/legacy negotiation.
- Persist the negotiated era and exact revision in the in-memory connection
  state.
- Allow only `2025-11-25` and `2026-07-28`.
- Disable automatic multi-round-trip fulfillment.
- Make session termination and 404 session-expiry handling legacy-only.
- Prove a real modern HTTP connect, catalog read, and tool call.

Gate: modern and legacy unit cases pass; a real modern server negotiates
`2026-07-28`; an unsupported revision fails closed; a modern 404 is not mapped
to legacy session expiry.

### 2. Cross-era catalog invalidation and cache hints

Status: next

- Use the SDK cross-era `listChanged.tools` callback with `autoRefresh: false`.
- Test both the legacy notification and modern `subscriptions/listen`.
- Carry `ttlMs` and `cacheScope` through `McpProtocolPage`.
- Keep one full, bounded, multi-page refresh as the only revision publication
  path.
- Treat a change event or descriptor mismatch as stronger than any TTL.
- Keep cache data private to one connection and user. Do not share `public`
  cache entries yet.

Gate: both eras invalidate the current revision; a change during pagination
cannot publish; no cache hint can preserve stale descriptor authority.

### 3. Schema and header safety

Status: pending

- Change output validators from object-only to any JSON value.
- Test primitive, array, object, and `null` `structuredContent`.
- Test primitive and array `outputSchema` roots.
- Keep bounded local `$ref` support and reject external references.
- Reject descriptors that contain `x-mcp-header` in the first profile.
- Remove the legacy core `execution.taskSupport` check. Keep Tasks unavailable
  through capability and extension negotiation.

Gate: valid widened outputs pass; invalid outputs keep provenance; external
references, over-complex schemas, and `x-mcp-header` fail before publication or
dispatch.

### 4. OAuth and connection state for issue #547

Status: pending

- Key registrations and tokens by authorization-server issuer.
- Persist OAuth discovery state with the credential.
- Validate callback `state`, then pass callback parameters to `finishAuth` so
  the SDK validates `iss`.
- Prefer Client ID Metadata Documents. Keep DCR only as a compatibility
  fallback.
- Convert `InsufficientScopeError` into a visible re-consent state. Do not
  retry the tool call.
- Preserve encrypted server custody, endpoint pinning, redirect validation,
  single-flight refresh, and refresh-token retention.

Gate: issuer and `iss` mismatch fail closed; missing discovery state cannot
continue; insufficient scope parks visibly without a second `tools/call`.

### 5. Trace context

Status: pending

- Create spans for connect/discover, catalog refresh, and broker invocation.
- Add controlled `traceparent` and optional `tracestate` to outbound `_meta`.
- Link the span to the invocation row without recording credentials, arguments,
  results, or arbitrary inbound baggage.

Gate: one scrubbed trace links the durable invocation to the outbound request.

### 6. Deferred feature gates

Status: pending

- Add tests that Alfred does not advertise MRTR handlers or the Tasks
  extension.
- Keep MCP Apps as a separate product proposal after this migration.

Gate: no durable continuation design means no MRTR or Tasks capability.

## Pull request boundaries

1. Adapter migration and cross-era transport tests.
2. Catalog subscription, cache hints, and schema/header rules.
3. Issue #547 OAuth and connection-state work.
4. Trace propagation.

Each pull request must preserve the no-replay broker tests and state which issue
it fully closes or only references.
