# Executor.sh fit for Alfred generic and multiple MCP connections

Date: 2026-08-30

## Conclusion

Executor is useful reference software for this feature. It is not a safe drop-in
replacement for Alfred's MCP runtime.

Executor solves the integration-administration problem in its own system. It has
integration definitions, named connection instances, several credential methods,
tool discovery, policy rules, a web application, and an MCP proxy. One integration
can have several connections. Its catalog can contain MCP, OpenAPI, and GraphQL
tools. See the official [integration](https://executor.sh/docs/concepts/integrations),
[connection](https://executor.sh/docs/concepts/connections), and
[MCP proxy](https://executor.sh/docs/mcp-proxy) descriptions.

Alfred already solves the more difficult execution-control part. Alfred has an
outbound MCP client, immutable catalog revisions, exact descriptor hashes,
fail-closed approval policy, a durable ambiguous-write barrier, bounded result
provenance, OAuth custody, and controlled trace propagation. The missing work is
mainly the generic connection product surface and its endpoint security.

The recommended choice is **selective borrowing**:

- Keep Alfred's raw client, broker, catalog authority, approval gate, OAuth store,
  and invocation ledger.
- Copy the useful product model and selected implementation patterns from Executor.
- Add Alfred-native integration and connection administration on top of the
  current broker.
- Do not put Executor in the production call path for this feature.
- Do not adopt Executor's QuickJS runtime as part of the generic MCP connection
  work. Treat code execution as a separate decision.

A sidecar is suitable only for a short manual product probe. A full embedded SDK
adoption is suitable only if Alfred intentionally replaces its existing MCP trust
boundary.

## What Executor does

Executor is an integration catalog and execution gateway for agents. Its
TypeScript SDK connects integrations, secrets, and policies. Published plugins
cover MCP, OpenAPI, GraphQL, file secrets, OS keychains, and 1Password. The
default SDK instance uses an in-memory store unless the host supplies the full
persistent runtime. The public SDK is Promise-based, but its plugin surface uses
Effect. See the pinned [SDK README](https://github.com/UsefulSoftwareCo/executor/blob/fff7ed68553c9d249966103b74c7ed4218fe45b1/packages/core/sdk/README.md#L1-L168).

Its main data concepts are useful for Alfred:

- An **integration** describes a catalog source.
- A **connection** is one named, configured instance of that integration. Several
  connections can use the same integration.
- A **secret reference** keeps credential text outside integration configuration.
- A **policy** selects `approve`, `require_approval`, or `block` for a tool-address
  pattern.
- A **host** exposes the catalog through the web application, API, CLI, or MCP.

The MCP plugin supports remote HTTP servers and local stdio servers. OAuth is
optional. Stdio is off by default and has a separate dangerous opt-in. When it is
on, a child process gets only a small environment allowlist plus explicit
integration variables. See the pinned
[`@executor-js/plugin-mcp` README](https://github.com/UsefulSoftwareCo/executor/blob/fff7ed68553c9d249966103b74c7ed4218fe45b1/packages/plugins/mcp/README.md#L1-L71).

Executor also has a code-execution surface. It runs model-written JavaScript or
TypeScript in QuickJS compiled to WebAssembly. Guest code gets a lazy `tools`
proxy. `fetch` is disabled. Tool calls cross a host bridge. The runtime has time,
memory, and stack limits. The documented defaults are 300 seconds, 64 MiB, and
1 MiB. See the pinned [runtime documentation](https://github.com/UsefulSoftwareCo/executor/blob/fff7ed68553c9d249966103b74c7ed4218fe45b1/packages/kernel/runtime-quickjs/README.md#L1-L59)
and [runtime source](https://github.com/UsefulSoftwareCo/executor/blob/fff7ed68553c9d249966103b74c7ed4218fe45b1/packages/kernel/runtime-quickjs/src/index.ts#L60-L65).

The packages inspected for this note are version `1.6.7` at commit
[`fff7ed6`](https://github.com/UsefulSoftwareCo/executor/tree/fff7ed68553c9d249966103b74c7ed4218fe45b1).
The MCP, SDK, execution, and QuickJS packages state that their APIs are pre-1.0
and can change. They use the MIT license.

## What Alfred has now

Alfred's built code has separate transport, connection, catalog, policy, and
execution layers.

- [`packages/assistant/src/connections/mcp/client.ts`](../../packages/assistant/src/connections/mcp/client.ts)
  owns protocol lifecycle, full catalog pagination, schema admission, exact input
  and output validation, catalog limits, result limits, and one-call dispatch.
- [`packages/assistant/src/connections/mcp/manager.ts`](../../packages/assistant/src/connections/mcp/manager.ts)
  owns live clients, stable refresh, immutable revision publication, and
  connection lifecycle.
- [`packages/assistant/src/tool-runtime/mcp/broker.ts`](../../packages/assistant/src/tool-runtime/mcp/broker.ts)
  owns authorization, descriptor-drift checks, effect classification, and the
  durable no-replay barrier.
- [`packages/db/src/schema/mcp.ts`](../../packages/db/src/schema/mcp.ts) stores
  connections, issuer-keyed OAuth credentials, OAuth attempts, immutable catalog
  revisions, exact per-tool policy, and invocation evidence.
- [`packages/assistant/src/tool-runtime/internal/tools/mcp.ts`](../../packages/assistant/src/tool-runtime/internal/tools/mcp.ts)
  projects all remote catalogs through two fixed Alfred tools: `mcp.list_tools`
  and `mcp.call`.
- [`packages/http/src/mcp.ts`](../../packages/http/src/mcp.ts) and
  [`apps/web/src/routes/-integrations/mcp-server-section.tsx`](../../apps/web/src/routes/-integrations/mcp-server-section.tsx)
  are still a GitHub-only connection route and one GitHub card.

The transport supports current and legacy MCP revisions and controlled trace
context. Thus, the pending labels in
[`docs/plans/mcp-2026-07-28-client-migration.md`](../plans/mcp-2026-07-28-client-migration.md)
do not all describe the present code.

Alfred's designed Code Mode is separate. ADR-0087 limits it to context
virtualization through object handles. It does not make it the generic MCP
composition layer. The repository does not currently depend on `run`, and it
does not contain the planned object-handle `code.run` implementation. See
[`ADR-0087`](../decisions/ADR-0087-code-mode-rung-b-v1-is-context-virtualization.md)
and the current package manifests.

## Important differences

| Area | Executor | Alfred | Effect on this feature |
| --- | --- | --- | --- |
| Product boundary | A general integration platform and inbound MCP proxy. | A personal assistant with an outbound MCP client and an Alfred-owned dispatcher. | Executor can be the integration system. It cannot silently become a helper below Alfred's existing authority. |
| Integration and connection model | Integration definitions are separate from named owner-scoped connections. One integration can have several accounts. | One `mcp_connections` row contains the endpoint and credential link. A unique `(user_id, canonical_resource)` index allows only one row per resource for a user. | Alfred needs a definition/instance split, or a new named-instance key, for true multiple-account support. |
| Supported sources | MCP, OpenAPI, GraphQL, and custom plugins. MCP supports remote HTTP and opt-in stdio. | Remote Streamable HTTP MCP only. This is an intentional hosted profile. | Executor has more breadth. Alfred does not need that breadth to add generic remote MCP. |
| Authentication | No auth, API-key placements, custom headers or query values, OAuth, and stdio environment inputs. | The shipped connection route assumes OAuth for one fixed GitHub server. OAuth storage and callback validation are strong, but generic no-auth and API-key setup are absent. | Executor's auth-template model is a good reference. |
| Catalog storage | Mutable per-connection tool rows. A 15-minute default TTL, change events, and unknown-tool errors mark or refresh stale catalogs. A failed refresh keeps the last working rows. See [catalog refresh source](https://github.com/UsefulSoftwareCo/executor/blob/fff7ed68553c9d249966103b74c7ed4218fe45b1/packages/core/sdk/src/executor.ts#L4930-L5055). | Immutable full-catalog revisions, a current pointer, stable catalog hashes, exact descriptor hashes, bounded all-page publication, and fail-closed invalidation. | Alfred's catalog is the stronger authorization record. Do not replace it with Executor's mutable rows. |
| Discovery | A unified tool catalog has lexical search, namespace search, and connection-aware addresses. | `mcp.list_tools` does bounded substring search inside one known connection. The model must already have its `connectionId`. | Alfred needs one cross-connection discovery surface and connection summaries. |
| Policy | Pattern rules support allow, approval, and block. Owner layers use most-restrictive-wins. See [policy resolver](https://github.com/UsefulSoftwareCo/executor/blob/fff7ed68553c9d249966103b74c7ed4218fe45b1/packages/core/sdk/src/policies.ts#L175-L271). For MCP, only an upstream `destructiveHint: true` makes the plugin require approval by default. See [MCP projection](https://github.com/UsefulSoftwareCo/executor/blob/fff7ed68553c9d249966103b74c7ed4218fe45b1/packages/plugins/mcp/src/sdk/plugin.ts#L499-L522). | Every unreviewed MCP call starts at `high`. A downgrade must bind to the owned connection, current revision, remote name, and exact descriptor hash. Effect class and retry contract are separate fields. | Alfred's default is safer for untrusted MCP metadata. Executor's pattern editor is useful UI reference, but its MCP default must not replace Alfred's floor. |
| Approval lifetime | The execution engine can pause and resume for elicitation and policy approval. | Approval is an Alfred action-staging state. It can survive process changes and binds validated input plus current risk. | A sidecar creates two independent approval systems and two resume protocols. |
| Retry and ambiguous writes | Executor retries a rejected `401` once only for a closed list of read-only or handshake methods. It never replays `tools/call`. See [the replay allowlist](https://github.com/UsefulSoftwareCo/executor/blob/fff7ed68553c9d249966103b74c7ed4218fe45b1/packages/plugins/mcp/src/sdk/connection.ts#L265-L370). It does not have Alfred's MCP-specific durable delivery ledger. | Alfred writes `delivery_possible` before an effectful network call. An uncertain result leaves an unresolved durable barrier. An identical call cannot run again without a host-minted successor. | Keep Alfred's broker. Borrow Executor's narrow pre-delivery replay tests and connection-pool tests only. |
| Endpoint security | Hosted Executor validates every HTTP and HTTPS target and redirect, resolves hostnames, blocks local/private and metadata addresses, and removes credential headers on cross-origin redirects. See [hosted outbound guard](https://github.com/UsefulSoftwareCo/executor/blob/fff7ed68553c9d249966103b74c7ed4218fe45b1/packages/core/sdk/src/hosted-http-client.ts#L1-L235). Local-network access is an explicit host option. | Alfred's production manager currently has a placeholder that checks HTTPS. It does not yet block private addresses or DNS rebinding. This is safe only because the route supplies one fixed GitHub URL. | A complete endpoint authorizer is a release gate for user-supplied URLs. Executor has useful test cases and code patterns for this gate. |
| Code execution | QuickJS Code Mode is a main invocation surface. It can search and call any registered tool through the host bridge. | The planned `run`-based tier is unbuilt and deliberately limited to object-handle work. | Executor's runtime solves a different problem. Generic MCP connections do not require it. |

## Adoption options

### 1. Executor as a gateway sidecar

Shape:

```text
Alfred -> one outbound MCP connection -> Executor -> many MCP/OpenAPI/GraphQL connections
```

This is the fastest product probe. Executor supplies the web application,
credentials, multiple accounts, catalog, and policies. Alfred would configure
only one MCP endpoint.

This is not a good production fit for the current Alfred broker:

1. The current Executor MCP host exposes an `execute` code tool, `skills`, and a
   `resume` tool. Optional `search_<integration>` tools still run code through
   `execute`. It does not expose each upstream tool as an individual raw MCP tool
   on this host surface. See the pinned
   [MCP host registrations](https://github.com/UsefulSoftwareCo/executor/blob/fff7ed68553c9d249966103b74c7ed4218fe45b1/packages/hosts/mcp/src/tool-server.ts#L1517-L1658).
2. Alfred would see one opaque code execution, not each upstream operation. It
   could not apply descriptor-bound policy, effect classification, or the
   ambiguity barrier to each nested write.
3. Executor would perform inner approval and retry decisions. Alfred would
   perform outer approval and retry decisions. A user could get duplicate
   approval prompts, and the two systems would not share a durable call identity.
4. Credentials and catalog authority would move to another service. Alfred's
   `mcp_connections`, `mcp_catalog_revisions`, and `mcp_invocation` records would
   describe the gateway, not the real upstream server.
5. This creates the exact stacked orchestration shape that
   [`docs/plans/mcp-client-raw-transport-decision-map.md`](../plans/mcp-client-raw-transport-decision-map.md)
   rejects.

Use this option only for a disposable product test. For example, test whether two
accounts, catalog search, and connection labels give enough user value. Do not
use writes in that test.

### 2. Embed the Executor SDK

Shape:

```text
Alfred process -> @executor-js/sdk + @executor-js/plugin-mcp -> upstream servers
```

This avoids the opaque inbound MCP code tool. Alfred can call
`executor.tools.list()` and `executor.tools.invoke()` directly. It also gets the
integration and connection plugin model.

The cost is high:

- The SDK brings its own integration, connection, tool-row, secret-provider,
  policy, elicitation, and storage abstractions.
- Its default store is in-memory. A real embedded use needs a persistent host and
  schema integration.
- Its plugin layer uses Effect. Alfred would have to adapt Effect failures and
  lifecycle into existing Promise and Elysia boundaries.
- Its catalog and policy identity do not match Alfred's immutable revision and
  descriptor-hash authority.
- It does not replace Alfred's durable ambiguous-write ledger and result
  provenance.
- The relevant published APIs are pre-1.0.

This option makes sense only as an intentional MCP runtime rewrite.

### 3. Selective borrowing

This is the recommended option.

Borrow or adapt these parts:

- The integration-definition plus named-connection model.
- The remote endpoint probe and transport detection flow.
- Auth templates for none, OAuth, header, and query credentials.
- The hosted outbound URL guard and its DNS, redirect, metadata-address, and
  credential-header tests.
- Owner-plus-connection identity in connection-pool keys.
- The narrow rule that a tool call never replays after a possible delivery.
- Global lexical discovery with namespace and connection filters.
- Connection health states and visible reconnect actions.
- The UI sequence: add integration, create one or more connections, inspect the
  catalog, then set policy.

Do not borrow these parts as authority:

- MCP `destructiveHint` as the default approval decision.
- Mutable tool rows as the authorization revision.
- Stale-catalog availability in place of Alfred's fail-closed current pointer.
- The Executor approval pause as a replacement for Alfred action staging.
- The QuickJS tool bridge as part of the connection feature.

The code is MIT licensed, but copied code still needs its license notice and a
normal dependency and security review.

## Exact Alfred gaps that remain

The generic and multiple MCP connection feature needs the following work.

1. **Separate a server definition from a connection instance.** The current
   `(user_id, canonical_resource)` unique index prevents two named accounts on
   one endpoint. Add a server/integration definition table, or change the
   connection identity to include a stable instance name. Keep credentials and
   catalog revisions connection-specific.
2. **Add arbitrary endpoint admission.** Add a probe endpoint and a create route.
   Validate the URL as `unknown`. Enforce HTTP policy before the probe, on DNS
   resolution, on each redirect, and on every reconnect. Pin the accepted origin
   and OAuth resource.
3. **Add generic authentication methods.** Support public/no-auth servers and
   explicit API-key header or query placements. Keep model-selected headers
   prohibited. Keep OAuth credentials in the existing MCP OAuth vault.
4. **Add connection CRUD.** Add list, create, rename, reconnect, re-consent,
   disconnect, and remove operations. Ensure that removal closes the process
   client and revokes or deletes its credential reference.
5. **Add the product UI.** Replace the one GitHub card with an add-server flow,
   endpoint probe results, auth selection, named account cards, health, catalog
   inspection, and delete/reconnect actions.
6. **Add cross-connection discovery.** The boss needs a bounded local query that
   finds tools and connections without first knowing a `connectionId`. The final
   call must still carry the full Alfred `ExternalToolRef`.
7. **Expose policy review.** `mcp_tool_policy` exists, but there is no user route
   or UI that writes the reviewed risk tier, effect class, retry contract, note,
   and policy revision. Schema drift must continue to invalidate the review.
8. **Finish recovery operations.** The schema has `same_key` and `reconcile`, and
   the persistence layer has a successor primitive. V1 still uses `never`, and
   there is no user reconciliation or successor flow. Do not add automatic write
   retry to make the feature appear complete.
9. **Add multi-connection lifecycle tests.** Test owner isolation, equal endpoints
   with different named accounts, independent credentials, independent catalog
   revisions, pool isolation, concurrent refresh, deletion during a call, OAuth
   reconnect, and one server changing its catalog while another stays ready.
10. **Keep Code Mode out of the acceptance criteria.** Direct `mcp.list_tools`
    plus `mcp.call` is sufficient for generic and multiple connections. Build
    object handles and `code.run` only under ADR-0087's separate evidence gate.

## Suggested delivery order

1. Add the integration/connection identity and migration.
2. Add the hosted endpoint authorizer with tests.
3. Add a read-only public MCP server through the generic route.
4. Add two named connections to one server and prove isolation.
5. Add OAuth and API-key setup variants.
6. Add global catalog discovery.
7. Add policy review UI for exact descriptor hashes.
8. Add one write tool and prove approval, uncertain delivery, and no replay.

This order uses Executor's best idea, which is the integration/connection split,
without moving Alfred's trust boundary.

## Final decision

Executor would solve the requested feature **if Executor became the owner of all
integrations and calls**. It does not solve the feature as a transparent package
inside Alfred.

For Alfred, the lowest-risk path is to complete the missing connection control
plane over the runtime that already exists. Executor should be a primary design
and test reference. It should not be the production gateway or the execution
broker.
