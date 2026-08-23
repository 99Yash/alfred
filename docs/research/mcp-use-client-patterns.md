# mcp-use client patterns relevant to Alfred issue #540

Status: researched 2026-07-25
Scope: the `mcp-use` monorepo (TypeScript library `mcp-use@1.34.5`, MIT), read as a _client_
implementation; comparison with
[`mcp-raw-client-v1-requirements.md`](./mcp-raw-client-v1-requirements.md),
[`vscode-mcp-client-patterns.md`](./vscode-mcp-client-patterns.md), and
[`mcp-ambiguous-write-outcomes.md`](./mcp-ambiguous-write-outcomes.md).
Source snapshot: [`feda0068`](https://github.com/mcp-use/mcp-use/tree/feda006831b6019eb65025d379db5074f4205096)
(2026-07-24). Paths below are relative to `libraries/typescript/packages/mcp-use/src/`.

## Conclusion

Do not take the dependency. `mcp-use` is a batteries-included agent framework — LangChain agents, an
MCP _server_ builder, React hooks, widgets, an inspector — and its published package carries
`express`, `hono`, `@hono/node-server`, `posthog-node`, `posthog-js`, plus its own CLI and inspector
as **runtime** dependencies, while pinning `@modelcontextprotocol/sdk` at 1.26.0 against Alfred's
1.29.0. Alfred needs a hardened outbound client, which is the one thing the library does not supply:
it performs no argument validation against `inputSchema`, no `outputSchema`/`structuredContent`
validation, no catalog byte/depth/node bounds, no `$ref`/`$id` hygiene, no result bounding, and no
descriptor or revision hashing. Nearly everything in `packages/api/src/modules/mcp/client.ts` is work
this client simply does not do.

The licence is MIT, so lifting a specific 30-line helper is fine where one is worth lifting.

As with VS Code, the most valuable finding is **negative**, and it is the same finding: a widely used
MCP client transparently re-sends a `tools/call` after a session error. That is now two independent
implementations exhibiting the hazard the ambiguity ledger exists to prevent — one of them a library
whose entire purpose is being the MCP client.

## The negative finding: transparent replay after a session 404

`task_managers/streamable_http.ts:32-73` and `task_managers/sse.ts:63-115` both wrap
`transport.send`, and on a `404` with a live session id they clear the session id, call
`reinitialize()`, and then **re-send the original JSON-RPC message** — `tools/call` included. There is
no effect classification, no idempotency key, no operation ledger, and no reconciliation. Worse,
`reinitialize()` is a no-op that only logs
([streamable_http.ts:84-91](https://github.com/mcp-use/mcp-use/blob/feda006831b6019eb65025d379db5074f4205096/libraries/typescript/packages/mcp-use/src/task_managers/streamable_http.ts#L84-L91)),
so the "retry after re-initialize" is really a retry after nothing.

Blast radius, stated precisely:

- On the **Streamable HTTP** path the wrapper is effectively dead. `HttpConnector` builds the
  transport directly (`connectors/http.ts:298-317`) and never installs
  `StreamableHttpConnectionManager`; the only construction sites in the repo are in
  `tests/unit/client/404-reinit.test.ts`.
- On the **SSE fallback** path it is live: `connectWithSse` (`connectors/http.ts:432`) instantiates
  `SseConnectionManager`, which installs the replaying wrapper.

The second-order version of the same posture: `BaseConnector.callTool` injects a no-op `onprogress`
callback whenever `resetTimeoutOnProgress` is set (`connectors/base.ts:509-524`), specifically so a
server streaming progress notifications can keep extending the request timeout. That is exactly the
SDK behavior `protocol.ts` collapses with `maxTotalTimeout === timeout`, and for the same reason: an
extendable deadline blurs the delivery boundary the ledger depends on.

**Consequence for Alfred.** This is a concrete instance of the rule already written into the
no-replay invariant in `broker.ts` — _before admitting any wrapper into this path, confirm its retry
is disabled or provably pre-delivery_. Had Alfred wrapped the SDK with `mcp-use`, the
`session_expired` → `ambiguous` path would have been silently replaced by a double-write on the SSE
transport. Alfred's `isMcpSessionExpiredError` → rethrow (never re-issue) is the correct handling and
should not be "improved" into a reconnect-and-retry.

## Other places Alfred's boundary has no counterpart here

None of these are criticisms of the library — it targets a different problem — but they are worth
recording, because they establish that Alfred's client is not redundant orchestration over a solved
problem.

- **No input validation.** `BaseConnector.callTool` forwards `args` straight to
  `client.callTool({ name, arguments: args })`. The advertised `inputSchema` is used only to render
  tool definitions for the model, never to validate a proposal.
- **No output validation.** `structuredContent` and `outputSchema` appear nowhere on the client path
  (only in the server builder and the LangChain agent's own result schema).
- **No catalog identity.** Tool-set change detection is a hand-rolled deep `isEqual` over the
  converted tool list (`managers/server_manager.ts:18-55`), cached per connector. There is no
  revision hash, no per-descriptor hash, and no immutable snapshot — so there is nothing an approval
  or a reviewed policy could bind to.
- **No result bounding**, and `logger.debug("Tool '%s' returned", res)` logs the full untrusted
  result object.
- **Client capabilities are opened, not closed.** Sampling and elicitation callbacks are supported
  and advertised when supplied (`client.ts:121-134`). Alfred v1 advertises an empty capability object
  deliberately.
- **Telemetry is on by default** (PostHog EU + Scarf, `MCP_USE_ANONYMIZED_TELEMETRY=false` to
  disable). Payloads are redacted — `ClientAddServerEvent` sends the URL _hostname_ and a `has_auth`
  boolean, not the config — so this is an egress-posture note, not a leak.

## Reusable patterns

### Detail tiers on tool discovery — adopted

`createSearchToolsFunction` (`client/executors/base.ts:138-205`) takes a
`detail_level` of `"names" | "descriptions" | "full"` and returns a `meta` block alongside the
results (`total_tools`, `namespaces`, `result_count`).

The `"names"` tier is the idea worth having: on a wide catalog (GitHub's official server advertises
160+ tools) the descriptions dominate a discovery page, and a model surveying what exists does not
need them. Alfred's `mcp.list_tools` previously had two densities — clipped summaries for a page, one
full descriptor for a named tool — so a survey of a wide catalog paid for prose it discarded.

Adopted as a `detail: "names" | "summary"` input (`packages/contracts/src/mcp.ts`,
`packages/api/src/modules/mcp/list-tools.ts`), defaulting to `summary`. Two deliberate divergences:

- **No `"full"` tier.** A full descriptor is bounded at 128 KB at ingest, so a _page_ of them
  reinstates precisely the catalog dump clarification #5 exists to prevent. Full descriptors stay
  reachable one at a time via `remoteName`.
- **Projection happens after filtering**, so `query` matches against the complete summary in every
  tier. A names-only page returns the same tools a summary page would, minus the prose — rather than
  quietly narrowing what `query` can match.

The `meta` block was not adopted: `namespaces` is a multi-server concept and Alfred's reader is
scoped to one connection, and `toolCount` already carries the full match count next to the page.

### `probeAuthParams` — worth lifting for the OAuth slice

`auth/probe-www-auth.ts` (35 lines) POSTs a bare `initialize` to the MCP endpoint expressly to
provoke the `401`, then reads `resource_metadata` and `scope` out of `WWW-Authenticate` via the SDK's
`extractWWWAuthenticateParams`.

The requirements doc already mandates parsing the 401 challenge; this is the concrete _probe-first_
shape, and it is what makes the connect-time UX honest — Alfred can show which scopes a server will
demand **before** redirecting the user, instead of discovering them mid-flow. Note the shortcut in
their version (appending `/mcp` when the URL does not end in it) is a guess Alfred should not copy:
the endpoint is pinned configuration, not something to fix up.

### Three refresh-correctness details

From `auth/oauth-session-store.ts`, all small and all easy to omit:

1. **Single-flight refresh** (`_dedupedRefresh`, lines 342-352). Concurrent callers share one in-flight
   refresh promise instead of racing two token exchanges. Matters for Alfred because a rotating
   refresh token makes the loser of that race a persisted dead credential.
2. **Keep the incumbent refresh token when the AS does not rotate one** (lines 330-334):
   `refresh_token: newTokens.refresh_token ?? tokens.refresh_token`. Blindly persisting the response
   strands the connection on the next refresh.
3. **Never hand back a token inside its expiry margin** (lines 143-153): 30 s before `exp`, refresh or
   return `undefined` — never return the nearly-dead token.

Also worth copying: `clientInformation()` (lines 171-207) invalidates cached client registration when
the stored `redirect_uris` no longer contain the current redirect URL, instead of looping against a
dead registration.

### `@mcp-use/inspector` — dev tool only

Published separately with a Docker image. Useful for poking a candidate server (its `tools/list`
shape, pagination, auth challenge) before admitting it, with no runtime coupling to Alfred.

## Explicitly rejected

- **The auth module.** Token custody is browser-side — `localStorage`, popup + `BroadcastChannel`,
  DCR-first (`auth/browser-provider.ts`, `auth/callback.ts`). Alfred requires server custody behind
  encrypted credential references, and the requirements doc forbids OAuth material reaching
  browser-readable state. Their Node provider (`auth/node-provider.ts`) is a loopback-CLI flow bound
  to `127.0.0.1`, irrelevant to a hosted assistant. Because they call the SDK's `auth()` directly,
  they also inherit the SDK laxity the requirements doc says to override: no PRM-required posture, no
  `code_challenge_methods_supported` presence-and-S256 check.
- **Code mode.** `client/executors/vm.ts` uses `node:vm`, which is not a security boundary — ADR-0087's
  isolated-vm choice stands. Their tool wrapper also `JSON.parse`s `content[0].text` and discards the
  rest of the content array along with `isError` (lines 262-278), silently converting a tool-level
  rejection into an ordinary value. `client/connectors/codeMode.ts` exposes the single opaque
  `execute_code` tool that `mcp-raw-client-v1-requirements.md` already rules out for a remote server.
- **`ServerManager`.** Exposes management tools plus only the active server's tools
  (`managers/server_manager.ts:183-205`) — the same instinct as Alfred's lazy tool surface
  (#411/#412), with less structure.
- **LangChain adapters.** Wrong framework; Alfred is on the AI SDK.
- **The `mcpServers` config file as a runtime source.** The _shape_ is worth accepting as a
  paste-to-connect import in the connection-creation UI, since users already have one from Claude
  Desktop or Cursor — mapped into `mcp_connections` rows and filtered to HTTPS. It should not become
  a source of truth Alfred reads at runtime.
