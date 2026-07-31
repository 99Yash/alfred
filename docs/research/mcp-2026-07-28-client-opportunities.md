# MCP `2026-07-28` and `mcp-use` beta: client opportunities for Alfred

Status: researched 2026-07-31

Scope: Alfred as an outbound MCP client only; no Alfred MCP server

Primary-source snapshots:

- MCP specification stable tag [`2026-07-28`](https://github.com/modelcontextprotocol/modelcontextprotocol/releases/tag/2026-07-28), commit [`5f5440b`](https://github.com/modelcontextprotocol/modelcontextprotocol/commit/5f5440b)
- Official TypeScript SDK client [`@modelcontextprotocol/client@2.0.0`](https://github.com/modelcontextprotocol/typescript-sdk/tree/%40modelcontextprotocol/client%402.0.0), tag commit `ba0cd9ba0c5d56d1cf5635adece92349dff5af38`
- `mcp-use` beta branch at [`bc3f92cb5f221a9dace8d4f82e9d8edc3767578c`](https://github.com/mcp-use/mcp-use/tree/bc3f92cb5f221a9dace8d4f82e9d8edc3767578c), 2026-07-30

## Conclusion

Yes. The important work is entirely on Alfred's client side.

The immediate move is to migrate Alfred's narrow transport adapter from
`@modelcontextprotocol/sdk@1.29.0` to the official split
`@modelcontextprotocol/client@2.0.0`, then enable automatic modern/legacy
negotiation at that seam. Do **not** add `@mcp-use/client` to Alfred's production
path. Its new beta is a useful compatibility and test reference, but Alfred
already owns the security-critical parts it does not: immutable catalog
revisions, schema-complexity limits, exact input/output validation, reviewed
per-descriptor policy, durable approval, ambiguous-write handling, and bounded
results.

The migration should preserve Alfred's broker and no-replay rules. It should not
be a package swap followed by broad MCP feature enablement.

The highest-value changes are:

1. support the modern stateless wire while retaining legacy fallback;
2. update catalog invalidation for `subscriptions/listen` and consume cache
   hints without weakening descriptor-hash authority;
3. implement the new OAuth issuer, discovery-state, and scope-step-up rules in
   Alfred's server-custodied OAuth slice;
4. test primitive `outputSchema` roots, `structuredContent` of any JSON type,
   and the new `x-mcp-header` behavior;
5. add trace-context propagation from Alfred's existing operation ledger;
6. keep MRTR elicitation and the Tasks extension disabled until they have an
   Alfred-owned durable continuation design.

None of this needs an inbound `/mcp` endpoint or Alfred-as-MCP-server.

## Release reality: it is stable now, not a new RC

The release candidate for revision `2026-07-28` was published on **2026-05-29**
at commit `9d700ed`. The final specification was published on **2026-07-28** at
commit `5f5440b`. As of this research date, the final release is therefore the
implementation target, not the RC. The official release pages record both
dates and commits ([stable release](https://github.com/modelcontextprotocol/modelcontextprotocol/releases/tag/2026-07-28),
[RC release](https://github.com/modelcontextprotocol/modelcontextprotocol/releases/tag/2026-07-28-RC)).

The official TypeScript SDK also reached stable `2.0.0` on 2026-07-27/28 as
split packages, including `@modelcontextprotocol/client` and
`@modelcontextprotocol/core`. The package versions and publication timestamps
are in the npm registry
([client metadata](https://registry.npmjs.org/%40modelcontextprotocol%2Fclient),
[core metadata](https://registry.npmjs.org/%40modelcontextprotocol%2Fcore)).
The official v2 migration guide directs v1 users away from the unified
`@modelcontextprotocol/sdk` package and explains the split package mapping
([upgrade guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)).

Alfred currently pins the unified SDK at `1.29.0`, hard-requires protocol
`2025-11-25`, uses `initialize`, keeps an `Mcp-Session-Id`, and listens for the
legacy unsolicited `notifications/tools/list_changed` event
([package manifest](../../packages/api/package.json),
[`client.ts`](../../packages/api/src/modules/mcp/client.ts),
[`protocol.ts`](../../packages/api/src/modules/mcp/protocol.ts)). This is a
clean, narrow seam for the migration.

## What changed in the protocol

The full official delta is in the
[`2026-07-28` changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog).
The client-relevant changes are:

- **Stateless and sessionless core.** `initialize`,
  `notifications/initialized`, `Mcp-Session-Id`, and protocol-level sessions
  are removed. Each request carries protocol/client metadata, and
  `server/discover` advertises supported versions, capabilities, and server
  identity. The official SDK calls the pre-2026 behavior `legacy` and the new
  behavior `modern`
  ([protocol-version guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md)).
- **Modern/legacy negotiation.** In v2, `versionNegotiation.mode: "auto"`
  probes with `server/discover` and falls back to the legacy handshake. A pin to
  `2026-07-28` rejects a legacy-only server. The default remains legacy unless
  the client opts in
  ([official support guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md#serving-the-2026-07-28-revision)).
- **Change delivery.** Modern servers deliver list-change events only through a
  client-opened `subscriptions/listen` stream. The official SDK maps the same
  `ClientOptions.listChanged` handlers across both eras and opens the modern
  subscription automatically
  ([official support guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md#subscriptionslisten)).
- **Cache hints.** `tools/list` and other cacheable results now include required
  `ttlMs` and `cacheScope` fields. The conservative default is `ttlMs: 0` and
  `cacheScope: "private"`
  ([spec changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog#minor-changes),
  [SDK behavior](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md#cache-fields-and-cache-hints)).
- **Multi Round-Trip Requests (MRTR).** The server-to-client request channel is
  replaced by `input_required` results. The client collects requested input and
  retries the original method with `inputResponses` and opaque
  `requestState`
  ([spec changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog#major-changes),
  [SDK guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md#multi-round-trip-requests)).
- **Tasks moved out of core.** Tasks are now the independently negotiated
  `io.modelcontextprotocol/tasks` extension. Roots, Sampling, and Logging are
  deprecated, with a minimum twelve-month deprecation window under the new
  lifecycle policy
  ([spec changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog#deprecated)).
- **HTTP routing and argument headers.** Modern Streamable HTTP requires
  `Mcp-Method` and `Mcp-Name`. A tool schema can use `x-mcp-header`, which makes
  the client mirror selected argument values into `Mcp-Param-*` headers. The
  official SDK performs this behavior and validates mismatches
  ([spec changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog#minor-changes),
  [SDK guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md#mcp-param--and-standard-headers-sep-2243)).
- **Schema/output widening.** Tool schemas can use all JSON Schema 2020-12
  keywords. `outputSchema` may have a primitive or array root, and
  `structuredContent` may be any JSON value. Clients must not automatically
  dereference external `$ref` values and should bound resolution work
  ([spec changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog#minor-changes),
  [SDK v2 migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md#tool-output)).
- **Authorization hardening.** Clients must keep credentials keyed by the
  authorization-server issuer, validate a returned RFC 9207 `iss`, persist
  discovery state across restarts, and handle `403 insufficient_scope` through
  reauthorization or a typed error. Dynamic Client Registration is deprecated
  in favor of Client ID Metadata Documents, while it remains a compatibility
  fallback
  ([spec changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog#minor-changes),
  [SDK auth migration](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md#auth)).
- **Tracing.** The specification documents W3C Trace Context keys in `_meta`:
  `traceparent`, `tracestate`, and `baggage`
  ([spec changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog#minor-changes)).
- **No transport replay guarantee.** SSE resumability and redelivery were
  removed. A broken modern response stream loses the in-flight request; a new
  request needs a new request ID
  ([spec changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog#major-changes)).
  This does not prove that an effectful tool failed. Alfred's existing
  ambiguous-write ledger remains necessary.

## What is new in `mcp-use`

The beta branch changed materially since the prior Alfred research snapshot from
2026-07-24.

At beta HEAD on 2026-07-30:

- the umbrella package is `mcp-use@2.0.0-beta.66`
  ([package manifest](https://github.com/mcp-use/mcp-use/blob/bc3f92cb5f221a9dace8d4f82e9d8edc3767578c/libraries/typescript/packages/server/package.json));
- the standalone client is `@mcp-use/client@2.0.0-beta.17`, published
  2026-07-28
  ([package manifest](https://github.com/mcp-use/mcp-use/blob/bc3f92cb5f221a9dace8d4f82e9d8edc3767578c/libraries/typescript/packages/client/package.json),
  [npm metadata](https://registry.npmjs.org/%40mcp-use%2Fclient));
- that client now depends on stable
  `@modelcontextprotocol/client@2.0.0` and
  `@modelcontextprotocol/core@2.0.0`
  ([package manifest](https://github.com/mcp-use/mcp-use/blob/bc3f92cb5f221a9dace8d4f82e9d8edc3767578c/libraries/typescript/packages/client/package.json));
- HTTP defaults to automatic modern/legacy negotiation, exposes
  `protocolEra` and `protocolVersion`, and uses the SDK's cross-era
  `listChanged` configuration
  ([HTTP connector](https://github.com/mcp-use/mcp-use/blob/bc3f92cb5f221a9dace8d4f82e9d8edc3767578c/libraries/typescript/packages/client/src/transport/http.ts),
  [session API](https://github.com/mcp-use/mcp-use/blob/bc3f92cb5f221a9dace8d4f82e9d8edc3767578c/libraries/typescript/packages/client/src/core/session.ts));
- it adds automatic OAuth provisioning, issuer-keyed credential storage,
  persisted discovery state, browser/Node conditional entry points, React
  hooks, MCP Apps hosting, and compatibility tests across v1/v2 servers
  ([client changelog](https://github.com/mcp-use/mcp-use/blob/bc3f92cb5f221a9dace8d4f82e9d8edc3767578c/libraries/typescript/packages/client/CHANGELOG.md),
  [OAuth store](https://github.com/mcp-use/mcp-use/blob/bc3f92cb5f221a9dace8d4f82e9d8edc3767578c/libraries/typescript/packages/client/src/auth/session-store.ts)).

These are good reference implementations and test cases. They do not overturn
the earlier conclusion in
[`mcp-use-client-patterns.md`](./mcp-use-client-patterns.md).

`@mcp-use/client` remains the wrong production boundary for Alfred:

- it owns sessions, reconnect behavior, a mutable tool cache, optional telemetry,
  OAuth UX, and broad client features that Alfred already owns or deliberately
  excludes;
- its default client capabilities include Roots, and it enables Sampling or
  Elicitation when callbacks are supplied
  ([base connector](https://github.com/mcp-use/mcp-use/blob/bc3f92cb5f221a9dace8d4f82e9d8edc3767578c/libraries/typescript/packages/client/src/transport/base.ts),
  [HTTP connector](https://github.com/mcp-use/mcp-use/blob/bc3f92cb5f221a9dace8d4f82e9d8edc3767578c/libraries/typescript/packages/client/src/transport/http.ts));
- it auto-refreshes its own one-page mutable tool cache, while Alfred must fetch
  all pages, validate all descriptors, and atomically publish one immutable
  revision
  ([base connector](https://github.com/mcp-use/mcp-use/blob/bc3f92cb5f221a9dace8d4f82e9d8edc3767578c/libraries/typescript/packages/client/src/transport/base.ts));
- it configures transport reconnection retries. That can be appropriate for
  subscription streams, but Alfred cannot admit any reconnection layer into the
  call path until tests prove that an effectful `tools/call` is never replayed
  ([HTTP connector](https://github.com/mcp-use/mcp-use/blob/bc3f92cb5f221a9dace8d4f82e9d8edc3767578c/libraries/typescript/packages/client/src/transport/http.ts));
- its `callTool` surface accepts `Record<string, any>` and returns the SDK result.
  Alfred still needs its own exact-schema validation, provenance, bounding, and
  durable ambiguity barrier
  ([session API](https://github.com/mcp-use/mcp-use/blob/bc3f92cb5f221a9dace8d4f82e9d8edc3767578c/libraries/typescript/packages/client/src/core/session.ts)).

The beta also requires Node `>=22.22.2`, while Alfred currently declares
`>=22.12.0`
([mcp-use client manifest](https://github.com/mcp-use/mcp-use/blob/bc3f92cb5f221a9dace8d4f82e9d8edc3767578c/libraries/typescript/packages/client/package.json),
[`package.json`](../../package.json)). This is not the main reason to reject it,
but it prevents a no-cost dependency swap.

## Recommended client work for Alfred

### P0 — Migrate only the protocol adapter to the official v2 client

Replace the imports in `packages/api/src/modules/mcp/protocol.ts` with the split
official client package. Keep `McpProtocolClient`, `McpRawClient`,
`McpConnectionManager`, and `McpExecutionBroker` as Alfred-owned layers.

Configure:

- empty client capabilities;
- strict remote-capability enforcement;
- Streamable HTTP only;
- `versionNegotiation: { mode: "auto" }`;
- explicit normal and total request deadlines;
- no automatic replay of `tools/call`.

Persist both `protocolEra` and the exact negotiated version. Remove the
`MCP_V1_PROTOCOL_VERSION` equality gate, but retain an explicit allowlist of
`2025-11-25` and `2026-07-28` until a later revision is tested. For modern
connections, do not call `terminateSession()` and do not interpret a 404 as
session expiry. Keep the legacy session-expiry path only for legacy
connections.

Use the official SDK migration guides as the implementation source
([v1-to-v2](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md),
[modern protocol support](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)).

### P0 — Make catalog authority cross-era

Configure `ClientOptions.listChanged` so the SDK maps legacy notifications and
modern `subscriptions/listen` to one Alfred invalidation callback. The callback
must continue to invalidate the whole snapshot; it must not accept the SDK's
mutable one-page cache as authority.

Carry `ttlMs` and `cacheScope` through `McpProtocolPage`. A positive TTL can
avoid an unnecessary network refresh, but it must never extend authority after
a list-change event or descriptor mismatch. Treat `private` as connection/user
scoped. Do not share a cached catalog across users merely because a server says
`public` until Alfred has a reviewed cache-partition policy.

The official SDK can also cache a prior `server/discover` verdict and skip a
probe on later workers. Alfred can persist this as a performance hint, not as
server identity or authorization
([SDK enhancement](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md#clientconnecttransport--prior--connect-from-a-cached-era-verdict)).

### P0 — Complete OAuth using the new rules

Issue #547's OAuth/SSRF/connection work should target the 2026 rules directly:

- key registration and token records by authorization-server issuer;
- persist the SDK discovery state with the credential;
- pass callback parameters to `finishAuth` and validate `iss`;
- prefer Client ID Metadata Documents; retain DCR only as fallback;
- set DCR `application_type` correctly when fallback is used;
- handle `InsufficientScopeError` as an Alfred re-consent/step-up state, not an
  invisible retry;
- preserve Alfred's server-side encrypted token custody, single-flight refresh,
  refresh-token retention, endpoint pinning, redirect-hop validation, and SSRF
  policy.

`mcp-use` is useful for issuer-keyed/discovery-state test ideas, but its browser
and loopback OAuth providers are not Alfred's hosted custody model
([mcp-use OAuth store](https://github.com/mcp-use/mcp-use/blob/bc3f92cb5f221a9dace8d4f82e9d8edc3767578c/libraries/typescript/packages/client/src/auth/session-store.ts)).

### P0 — Re-baseline schema and header safety

Add fixtures for:

- primitive and array `outputSchema` roots;
- primitive, array, `null`, and object `structuredContent`;
- all supported content-block combinations plus `isError`;
- local `$ref` with bounded depth/node count;
- rejected external `$ref`;
- JSON Schema 2020-12 keywords that the current validator did not see;
- `x-mcp-header`.

Alfred's current rejection of external references and its complexity bounds
already match the new specification's defensive guidance. Keep them.

For `x-mcp-header`, make an explicit policy choice before enabling modern
calls. The safe first profile is to reject tool descriptors containing that
keyword. A later profile can permit it only after bounding header name/value
sizes and proving that `Mcp-Param-*` cannot affect Alfred's credential,
authorization, cache, proxy, or SSRF decisions. Do not let a server-authored
schema silently create a new model-selected header channel.

The v2 `Tool` wire shape also removes the old core
`execution.taskSupport` member. Remove Alfred's v1 check and instead decline the
Tasks extension during capability negotiation
([official migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md#json-schema--structured-content)).

### P1 — Propagate trace context

Generate a span for connect/discover, catalog refresh, and each broker
invocation. Put a controlled W3C `traceparent` (and, only when needed,
`tracestate`) in MCP `_meta`. Link it to Alfred's invocation row and existing
observability IDs. Do not forward arbitrary inbound `baggage`, and do not place
user content, credentials, arguments, or tool output in trace attributes.

This gives one trace from Alfred's durable approval/call record through an MCP
server without exposing Alfred as an MCP server.

### P2 — Design MRTR as a durable broker continuation, then opt in

MRTR is promising for a hosted client because the modern request is stateless
and can carry an opaque continuation handle. It is not safe to turn on by
passing an in-memory `onElicitation` callback.

If Alfred adopts it:

- treat `input_required` as a broker outcome, not a completed tool result;
- persist and size-bound `requestState` and every request/response;
- bind the continuation to user, connection, tool descriptor hash, catalog
  revision, canonical original arguments, and invocation id;
- route form/URL elicitation through Alfred's existing durable staging UX;
- revalidate everything before retrying the original call;
- preserve the no-replay rule for unknown effectful outcomes;
- never treat remote `requestState` as authenticated or confidential.

Until that design exists, do not advertise Elicitation, Sampling, or Roots.

### P2 — Keep Tasks deferred

The Tasks feature is now an official extension, which is more stable than the
old experimental core surface. It still introduces another durable execution
state machine. Alfred already has runs, action stagings, invocation records,
timeouts, unknown outcomes, and reconciliation. Do not add the extension until
a real server/use case needs it and one mapping defines which system owns
cancellation, retry, approval, expiration, and finality.

## Suggested acceptance tests

1. Modern server: `server/discover` succeeds, no `initialize` or session ID is
   used, catalog and tool call succeed.
2. Legacy server: the modern probe falls back once, `initialize` succeeds, and
   the existing session-expiry behavior remains.
3. Unsupported version: fail closed before catalog publication.
4. Change events: legacy notification and modern `subscriptions/listen` both
   invalidate and atomically replace the full multi-page revision.
5. Cache: `ttlMs: 0`, positive private TTL, and list-change-before-expiry all
   preserve descriptor-hash authority.
6. No replay: abort, timeout, broken response stream, session 404, subscription
   reconnect, and OAuth retry never send an effectful `tools/call` twice.
7. OAuth: issuer mismatch, changed authorization server, `iss` mismatch,
   missing discovery state, DCR fallback, and insufficient-scope step-up all
   fail or park visibly.
8. Schema: primitive outputs and arbitrary JSON `structuredContent` validate;
   external refs and over-complex schemas fail.
9. Headers: an `x-mcp-header` descriptor is rejected in the first profile.
10. Trace: one scrubbed trace ID links the invocation ledger to the outbound MCP
    call without payload or credential attributes.

## Decision

Adopt the **official TypeScript SDK v2 as codec and transport**. Use `mcp-use`
beta as a test/reference corpus. Do not adopt it as Alfred's runtime client.

This keeps the best part of the new protocol—cross-era compatibility,
stateless modern requests, correct subscription plumbing, OAuth conformance,
and traceability—without replacing Alfred's stronger trust and durability
boundary.
