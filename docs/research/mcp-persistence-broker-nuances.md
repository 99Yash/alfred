# MCP persistence layer + execution broker: design nuances

Status: researched 2026-07-22
Scope: the layer **above** the already-built `McpRawClient`
(`packages/api/src/modules/mcp/client.ts`) — durable connection/catalog
persistence and the execution broker that routes MCP `tools/call` through
Alfred's existing dispatch / approval / idempotency boundary. **Persistence +
broker only.** OAuth flow, SSRF fetch policy, Code Mode host binding, object
handles, and connection UI are explicitly out of scope here (see the last
section for why each is safely deferrable for an offline-testable slice).

Primary sources followed to the owning line: the two design docs
(`docs/plans/mcp-client-raw-transport-decision-map.md`,
`docs/research/mcp-raw-client-v1-requirements.md`), the three MCP lessons in
`.lessons/`, ADR-0018/0069/0071/0074/0087 in `decisions.md`, and the live code
in `packages/api/src/modules/dispatch`, `.../tools`, `.../mcp`,
`packages/contracts/src`, and `packages/db/src/schema`.

---

## 1. Closed-union reconciliation: how an MCP tool crosses `dispatchToolCall` without widening `ToolName`

### What the closed union actually is

`ToolName` is a closed, exhaustive template-literal union derived from
`INTEGRATION_ACTIONS` (`packages/contracts/src/tools.ts:30-89`):

```ts
// tools.ts:87-89
export type ToolName = {
  [K in IntegrationSlug]: ActionSlug<K> extends never ? never : `${K}.${ActionSlug<K>}`;
}[IntegrationSlug];
```

`isToolName` (`tools.ts:143-153`) admits a string **only** if its
`integration.action` split is present in `INTEGRATION_ACTIONS`. `dispatchToolCall`
gates on it at the very top (`packages/api/src/modules/dispatch/index.ts:421`) —
anything not in the union returns `unknown_tool` before any work happens. The
registry (`registry.ts:205`) is a `Map<ToolName, RegisteredTool>`, write-once at
boot and frozen (`registry.ts:213-216`), with `registerTool` throwing on a name
whose action is not in `INTEGRATION_ACTIONS` (`registry.ts:240-245`). So a
per-connection, per-remote-tool `ToolName` is structurally impossible without
either widening the union to arbitrary strings (rejected by decision-map #4,
`...decision-map.md:139`) or mutating the frozen registry at runtime (violates
`registry.ts:213`).

### The passthrough tier already solved the analogous problem — and NOT the way the prompt guessed

The general read-only passthrough tier (ADR-0074 rung-a) is the exact
precedent, but the mechanism is **not** "one registered tool with a dynamic
sub-target in args." It is: **add a small set of FIXED action slugs to the
closed `INTEGRATION_ACTIONS` map, one per integration, and carry the dynamic
target in the args.** Each passthrough tool is a real, closed `ToolName`:

- `INTEGRATION_ACTIONS` contains `drive.request`, `github.request`,
  `notion.request`, …, and `railway.graphql` (`tools.ts:55-81`).
- Each registers as an ordinary `RegisteredTool` whose `inputSchema` is the
  passthrough envelope, e.g. `drive.request` at
  `packages/api/src/modules/tools/drive.ts:177-196`:
  `inputSchema: restPassthroughInput`, `execute` calls
  `runGooglePassthrough("drive", token, input)`.
- The dynamic sub-target (HTTP method + namespace-relative path + query, or the
  GraphQL document) travels **inside the validated args**, never in the tool
  name.
- The passthrough tool-name set is *derived from and re-validated against* the
  closed union at module load (`packages/contracts/src/passthrough.ts:136-145`):
  it builds `<slug>.<action>` and throws if `!isToolName(name)`. The union stays
  the single source of truth; nothing is cast.

So the passthrough tier is "**fixed registered ToolName(s) whose args carry the
dynamic target.**" The MCP broker mirrors this precisely.

### Recommendation for the MCP projection tool name(s)

**Add a dedicated `mcp` integration slug with two fixed actions**, not a
per-connection tool and not a `system.*` action:

```ts
// packages/contracts/src/tools.ts — INTEGRATION_SLUGS + INTEGRATION_ACTIONS
// add "mcp" to LOADABLE_INTEGRATION_SLUGS (tools.ts:4-19) and:
mcp: ["call", "list_tools"],   // -> ToolName "mcp.call" | "mcp.list_tools"
```

The open-ended `ExternalToolRef` (`client.ts:23-28`:
`connectionId + remoteName + catalogRevision`) rides entirely in the **args** of
`mcp.call` (see Q2), exactly as the REST path/method rides in
`restPassthroughInput`. `remoteName` is a validated string field, never a
`ToolName`. `isToolName` stays closed and exhaustive; `INTEGRATION_ACTIONS`
gains two entries, not arbitrary strings.

**Why `mcp` and not `system.mcp_call`:** the dispatcher forces
`policyMode = "autonomy"` for `integration === "system"`
(`dispatch/index.ts:663-664`), which would strip the per-user policy gate and
leave *only* the ADR-0069 high-tier floor to gate MCP writes. A dedicated `mcp`
slug keeps both levers: the user can set the `mcp` integration to `gated`
globally **and** the high-tier floor still applies. (This is a genuine design
choice — see Open Tension #1.)

**Human-friendly names** like `mcp:<connection-slug>:<remote-name>` remain
display/search aliases only, never authority keys (decision-map #4,
`...decision-map.md:150`). They can populate the `mcp.call` tool's discovery
metadata (`registry.ts:27-42`) so the lazy tool surface can *suggest* the call,
but the durable key is the `ExternalToolRef` in args.

---

## 2. Dispatch re-validation: the projected Zod `inputSchema` shape

### The re-validation seam

Dispatch re-parses input with the registered tool's Zod schema at
`dispatch/index.ts:532` (`tool.inputSchema.safeParse(normalized.input)`), and
`liveTool` re-parses again inside `execute` (`registry.ts:196`). MCP tools carry
their own JSON Schema, and `McpRawClient.callTool` **already** validates the
`arguments` against the exact imported JSON Schema with no coercion
(`client.ts:310-323`, via the AJV validator compiled in `refreshCatalog`,
`client.ts:229-257`). If the projected Zod schema tried to re-encode the
per-remote-tool JSON Schema, it would be a lossy second gate: a `z.object({...})`
strips unknown keys by default and cannot represent the full JSON-Schema
vocabulary, so it would silently drop fields the MCP tool legitimately needs.

### How passthrough shapes its schema (the template)

`restPassthroughRequestSchema` (`passthrough.ts:190-215`) validates the
**envelope** strictly (`method`, `path`, `query`) but keeps the opaque part
opaque: `body: z.unknown().optional()`. The comment at `passthrough.ts:184-188`
is explicit — `method`/`path` are kept permissive so a bad value reaches the
*read gate* as a visible `rejected` envelope rather than dying as a hidden Zod
`invalid_input`.

### Recommendation

Validate the **broker envelope** in Zod; treat the MCP `arguments` as an opaque
JSON object that Zod does not reshape. Reuse the existing `jsonObjectSchema`
(`packages/contracts/src/user-model.ts:425-426`, a `z.record(z.string(),
jsonValueSchema)`) — which is exactly what `McpRawClient` itself uses to admit
args at `client.ts:310`:

```ts
// packages/contracts/src/tool-schemas.ts (new)
export const mcpCallInput = z.object({
  connectionId: z.string().min(1),
  remoteName: z.string().min(1),
  // The catalog revision the model selected this tool under. Mismatch is a
  // VISIBLE re-resolve signal (client throws "catalog_stale"), not a Zod strip.
  catalogRevision: z.string().min(1),
  // Opaque MCP arguments — a JSON object, unreshaped. The exact per-tool
  // JSON-Schema validation happens in McpRawClient.callTool (client.ts:310-323).
  // z.record keeps ALL string keys (no stripping), so no field the JSON-Schema-
  // valid MCP args need is lost crossing dispatch's re-parse.
  arguments: jsonObjectSchema,
});

export const mcpListToolsInput = z.object({
  connectionId: z.string().min(1),
  catalogRevision: z.string().optional(),
});
```

Key properties:

- `jsonObjectSchema` is a `z.record`, which **does not strip** unknown keys, so
  dispatch's re-parse at `dispatch/index.ts:532` is a meaningful envelope check
  (connectionId/remoteName/catalogRevision present and well-typed) without being
  a lossy second gate over the MCP arguments.
- The authoritative, exact-schema, no-coercion validation stays where it already
  lives and is already tested: `McpRawClient.callTool` (`client.ts:317-323`).
  This directly honors the lesson
  `.lessons/route-mcp-tools-through-alfreds-trust-boundary.md` ("validate every
  model proposal in Alfred") and the requirements doc's "validate arguments
  without coercion before policy/approval and again after any approval edit"
  (`...requirements.md:88`) — the "again after approval edit" is covered because
  dispatch re-validates the decided input on the approved-resume path
  (`dispatch/index.ts:812`), which flows back through `execute` →
  `McpRawClient.callTool`.

Do **not** add per-remote-tool Zod. Do **not** use `.strict()`/`.passthrough()`
gymnastics on the arguments sub-object; `jsonObjectSchema` (a record) is the
correct opaque carrier.

---

## 3. `action_stagings` keying: how the richer MCP identity coexists with `(run_id, tool_call_id)`

### The existing keys

- **Row idempotency:** `action_stagings` is upserted idempotent on
  `(run_id, tool_call_id)` (`dispatch/index.ts:693-714`; unique index
  `action_stagings_run_tool_call_idx` at
  `packages/db/src/schema/action-policies.ts:90`). A re-dispatch of the same
  `tool_call_id` reads the stored row verbatim and branches on its status.
- **Input hash:** `proposedInputHash = hashToolInput(toolName, input)`
  (`dispatch/index.ts:621`). `hashToolInput` folds the tool name **and**
  `canonicalJson(input)` into an fnv1a64 digest
  (`packages/contracts/src/tools.ts:159-161`).
- **Retry-suppression** matches on `(run_id, toolName, proposedInputHash,
  status='rejected')` (`dispatch/index.ts:628-643`; partial index
  `action_stagings_rejected_retry_idx` at `action-policies.ts:95-97`).

### The requirements doc's richer key

`...requirements.md:67-78` and `103-114` want the durable approval/idempotency
key to bind: user + connection + pinned origin + remote tool name + catalog
revision/descriptor hash + canonical args hash + risk-policy revision.

### Recommendation: put the model-supplied identity in args (hashed for free); bind the server-resolved identity in a companion row — do NOT touch `hashToolInput`

`hashToolInput` is a shared, closed primitive keyed by `ToolName` and used by
every tool; do not special-case MCP inside it. Instead exploit the fact that the
`ExternalToolRef` (`connectionId`, `remoteName`, `catalogRevision`) lives in the
`mcp.call` **args** (Q1/Q2), so `canonicalJson(input)` already folds all three
into `proposedInputHash` **for free**. This gives a crucial correctness property
without any new hashing code:

- A catalog-drifted re-proposal carries a different `catalogRevision` in args →
  different `proposedInputHash` → it does **not** match a prior rejection and is
  **not** suppressed → it re-stages and re-approves. This is exactly the
  requirements-doc rule "if the catalog changes between proposal and execution,
  re-resolve and revalidate; never silently execute against a new schema"
  (`...decision-map.md:161`) falling out of the existing hash mechanism.
- `connectionId` + `remoteName` + canonical args are all in the hash, so
  same-input retry-suppression works identically to native tools.

What is **not** in the args (and must not be — it is untrusted if
model-supplied): pinned origin, auth-server identity, per-tool descriptor hash,
and risk-policy revision. These are resolved **server-side** by the broker at
dispatch time from the persisted connection/catalog/policy rows (Q4/Q5). Bind
them durably in a **new companion `mcp_invocation` row** (Q7) referencing the
staging row, rather than folding them into the generic input hash:

```ts
// keyed by staging row; records the fully-resolved server-side authority key
mcp_invocation(
  staging_id -> action_stagings.id,   // 1:1 with the staging row
  connection_id, catalog_revision_id, // server-resolved, not from args
  descriptor_hash,                    // the exact tool's descriptor hash
  pinned_origin, risk_policy_revision,
  invocation_key,                     // the broker's dedup key (requirements:114)
  outcome, ...                        // see Q7
)
```

**Net:** keep `(run_id, tool_call_id)` and `proposedInputHash` exactly as they
are. The connection/remote-name/catalog-revision/args components ride in args
(naturally hashed); the origin/descriptor-hash/policy-revision components live
on `mcp_invocation`, resolved and compared server-side by the broker before it
calls the remote. No change to `hashToolInput`; no new column on
`action_stagings`.

---

## 4. Persistence schema

Conventions confirmed from `action-policies.ts`, `integrations.ts`, and
`helpers.ts`: no `pgEnum` anywhere in the schema — enums are
`text("...").$type<LiteralType>()` with the literal type owned in
`@alfred/contracts`; ids are `text().$defaultFn(() => createId("<prefix>"))`
(`helpers.ts:29-32`); `user_id` FKs are `onDelete: "cascade"` (single-user FK
convention, `action-policies.ts:52-54`, `integrations.ts:40-42`); timestamps use
`{ withTimezone: true }`; `lifecycle_dates` (`helpers.ts:22-27`) supplies
`createdAt`/`updatedAt`; named `$inferSelect`/`$inferInsert` exports are required
(`packages/db/CLAUDE.md`).

The ADR-0018 sketch (`decisions.md:519-535`) has a single mutable
`capability_cache jsonb` that is both history and authority, plus a materialized
`mcp_server_tools`. The requirements doc (`...requirements.md:37-51`) and
decision-map #6 (`...decision-map.md:212`) explicitly reverse this: **persist
connection facts separately from immutable catalog revisions; do not use one
mutable blob as both history and current authority.** Below reconciles them.

```ts
// packages/db/src/schema/mcp.ts
import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { McpConnectionStatus, McpNegotiatedServer } from "@alfred/contracts"; // NEW literal union in contracts
import { createId, lifecycle_dates } from "../helpers";
import { user } from "./auth";
import { integrationCredentials } from "./integrations";

// ---------------------------------------------------------------------------
// Connection = durable FACTS (owner, pinned endpoint, auth identity, status,
// negotiated protocol, server identity/capabilities, current-revision pointer).
// NOT live SDK objects (requirements:51). NOT the catalog history.
// ---------------------------------------------------------------------------
export const mcpConnections = pgTable(
  "mcp_connections",
  {
    id: text("id").primaryKey().$defaultFn(() => createId("mcpc")),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    /** Human label shown in the connection UI. */
    label: text("label").notNull(),
    /** Canonical MCP resource URI — the OAuth `resource` indicator (requirements:128). */
    canonicalResource: text("canonical_resource").notNull(),
    /** Pinned endpoint + origin. The model NEVER supplies these (decision-map:118). */
    endpointUrl: text("endpoint_url").notNull(),
    endpointOrigin: text("endpoint_origin").notNull(),
    /** Selected authorization-server identity (RFC 8414/OIDC). Null for unauthenticated servers. */
    authServerIdentity: text("auth_server_identity"),
    /**
     * Reference to the audience-bound Alfred->MCP OAuth credential — NOT the
     * downstream provider grant (lesson: separate-mcp-client-server-and-oauth-roles).
     * Reuses integration_credentials (provider = "mcp"); null = no auth required.
     */
    credentialId: text("credential_id").references(() => integrationCredentials.id, {
      onDelete: "set null",
    }),
    /** Granted scopes parsed to an array (mirrors integration_credentials.scopes). */
    grantedScopes: jsonb("granted_scopes").notNull().default(sql`'[]'::jsonb`),
    /** disconnected | connecting | ready | stale | auth_required | failed (requirements:41-49). */
    status: text("status").$type<McpConnectionStatus>().notNull().default("disconnected"),
    /** Negotiated protocol version — v1 pins "2025-11-25" (client.ts:65). */
    negotiatedProtocolVersion: text("negotiated_protocol_version"),
    /** Server identity + capabilities snapshot (McpNegotiatedServer, protocol.ts:16-22). */
    serverIdentity: jsonb("server_identity").$type<McpNegotiatedServer>(),
    /**
     * Pointer to the currently-authoritative immutable revision. Nullable +
     * plain FK (not part of a cycle at insert time): connection is created with
     * null, first catalog load inserts a revision, then this is set. Never
     * cascade-deletes the revision — history is append-only.
     */
    currentCatalogRevisionId: text("current_catalog_revision_id"),
    lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("mcp_connections_user_resource_idx").on(t.userId, t.canonicalResource),
    index("mcp_connections_user_status_idx").on(t.userId, t.status),
  ],
);

// ---------------------------------------------------------------------------
// Catalog revision = IMMUTABLE, append-only authority + history. One row per
// atomically-published catalog snapshot. NO updatedAt / no $onUpdate — a
// revision is never mutated tool-by-tool (requirements:63).
// ---------------------------------------------------------------------------
export const mcpCatalogRevisions = pgTable(
  "mcp_catalog_revisions",
  {
    id: text("id").primaryKey().$defaultFn(() => createId("mcpr")),
    connectionId: text("connection_id").notNull().references(() => mcpConnections.id, {
      onDelete: "cascade",
    }),
    /** Stable authority hash = McpCatalogSnapshot.revision ("sha256:...", client.ts:381-384). */
    revisionHash: text("revision_hash").notNull(),
    /** Raw, validated descriptors exactly as admitted (Tool[]); the audit source. */
    descriptors: jsonb("descriptors").notNull(),
    /**
     * Per-tool descriptor hashes { [remoteName]: "sha256:..." }. Lets an
     * approval/downgrade bind to ONE tool's descriptor, so an unrelated tool
     * changing (which bumps the whole revisionHash) need not churn it. See Q5/Tension #3.
     */
    descriptorHashes: jsonb("descriptor_hashes").$type<Record<string, string>>().notNull(),
    toolCount: integer("tool_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("mcp_catalog_revisions_conn_hash_idx").on(t.connectionId, t.revisionHash)],
);

export type McpConnection = typeof mcpConnections.$inferSelect;
export type NewMcpConnection = typeof mcpConnections.$inferInsert;
export type McpCatalogRevision = typeof mcpCatalogRevisions.$inferSelect;
export type NewMcpCatalogRevision = typeof mcpCatalogRevisions.$inferInsert;
```

Add `export * from "./schema/mcp";` to `packages/db/src/schemas.ts`. New
contracts literal unions: `McpConnectionStatus` (the state-machine states) and a
browser-safe `McpNegotiatedServer` mirror (the API `McpNegotiatedServer` lives
in `protocol.ts:16-22`; a persisted `$type` needs a contracts-owned copy per
`packages/db/CLAUDE.md`).

Notes:

- **History vs authority is now structural:** `mcp_connections` carries only a
  *pointer* to the live revision; `mcp_catalog_revisions` is append-only. This
  is the direct reconciliation the requirements/decision-map asked for against
  ADR-0018's single mutable `capability_cache` blob.
- **The circular pointer** (`currentCatalogRevisionId`) is a plain nullable
  `text` (not a hard FK) to avoid an insert-ordering cycle; the broker sets it
  after publishing a revision. (A deferrable FK constraint could be added in
  migration SQL, but the nullable-text form matches how the repo already handles
  soft pointers and keeps `db:generate` clean.)
- **Credential custody** reuses `integration_credentials` with
  `provider = "mcp"` so the existing refresh/rotation machinery applies, storing
  only a reference on the connection (honoring
  `.lessons/separate-mcp-client-server-and-oauth-roles.md` — the Alfred→MCP
  bearer is separate from any downstream Google/GitHub grant). See Open
  Tension #5 for the reuse-vs-dedicated-store debate.

---

## 5. Risk classification: where an MCP tool's risk tier comes from, and where the downgrade policy lives

### How Alfred risk works today

`RegisteredTool.riskTier` is a **static** field set at registration
(`registry.ts:155`, `liveTool` at `registry.ts:171-203`). Dispatch reads it once
per call: `const riskTier = tool.riskTier` (`dispatch/index.ts:662`), then
`toolRequiresApproval(policyMode, riskTier)` (`dispatch/index.ts:952-954`):

```ts
return policyMode === "gated" || riskTier === "high";
```

The `high === always gates` floor is ADR-0069 (`decisions.md:3962-3976`;
registry header `registry.ts:8-14`) — a one-way floor the autonomy toggle cannot
override.

### The core problem: one `mcp.call` tool cannot carry a per-remote-tool static tier

There is exactly one registered `mcp.call` `RegisteredTool` (Q1), so its static
`riskTier` field cannot vary across remote tools or connections. Two facts from
the requirements doc constrain the answer:

- Annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`)
  are **untrusted hints**; default is gated/high; downgrade needs an Alfred-owned
  reviewed policy keyed by connection + tool + descriptor hash + policy revision
  (`...requirements.md:97-114`, decision-map #5 `...decision-map.md:178`).

### Recommendation

**Static registry tier = `high` (fail-safe floor); effective tier resolved
dynamically in dispatch from a new `mcp_tool_policy` table (default `high`).**

1. Register `mcp.call` with `riskTier: "high"` in the registry. If the dynamic
   resolver is ever bypassed, ADR-0069's floor still gates every MCP call — the
   safe default the requirements demand.

2. Add a dispatch seam that, for the `mcp` integration, resolves the **effective**
   tier before computing the gate — analogous to the existing passthrough
   availability recheck that already runs inside dispatch just for passthrough
   tools (`dispatch/index.ts:492-514`, keyed on
   `tool.availability?.passthrough`). Give `mcp.call` an
   `availability` marker and resolve:

   ```ts
   // in dispatchToolCall, replacing `const riskTier = tool.riskTier` for mcp tools:
   const riskTier: ToolRiskTier =
     integration === "mcp"
       ? await resolveMcpEffectiveRiskTier({
           userId: args.userId,
           connectionId, remoteName, descriptorHash, // from args + resolved catalog
         })
       : tool.riskTier;
   ```

   `resolveMcpEffectiveRiskTier` reads `mcp_tool_policy` for a matching
   `(connectionId, remoteName, descriptorHash, policyRevision)` and returns the
   reviewed tier; **absent, or descriptor-hash mismatch → `"high"`.** The
   annotations from the catalog descriptor feed only the review UI / a *suggested*
   tier — never auto-applied.

3. Store the downgrade policy in a **new `mcp_tool_policy` table**, not
   `user_action_policies` and not a column on the catalog revision:

   ```ts
   mcp_tool_policy(
     id, user_id -> user (cascade),
     connection_id -> mcp_connections (cascade),
     remote_name, descriptor_hash,          // binds to the EXACT reviewed descriptor
     policy_revision integer,               // bumped on each review edit
     risk_tier text $type<ToolRiskTier>,    // the reviewed tier (e.g. "low" for a read)
     reviewed_at, reviewed_note,
     lifecycle_dates,
     unique(connection_id, remote_name, descriptor_hash)
   )
   ```

   - Not `user_action_policies` (`action-policies.ts:24-44`): that is per-*integration*
     user *autonomy* (gated/autonomy), a different axis from a reviewed
     per-*remote-tool* security downgrade bound to a descriptor hash.
   - Not a column on `mcp_catalog_revisions`: revisions are immutable and
     append-only (Q4); a policy is edited independently and must survive across
     revisions when the descriptor hash is unchanged.

**Effect on the gate:** an un-reviewed MCP tool is `high` → always gates (floor).
A reviewed read downgraded to `low`/`no_risk` runs under the user's `mcp`
integration policy (autonomy if the user allows it). Descriptor drift (the
reviewed `descriptor_hash` ≠ the current catalog's) silently falls back to
`high` — the downgrade does not carry across a schema change, matching
"re-resolve and revalidate; never silently execute against a new schema"
(`...decision-map.md:161`).

---

## 6. Broker interface, placement, and connection lifecycle

### Where it lives

Alfred has **no DI container**; backend services are module-scoped singletons
with lazy init and Redis pub/sub for cross-instance cache invalidation — the
canonical example is the policy resolver
(`packages/api/src/modules/action-policies/resolve.ts`: a
`Map<string, Promise<...>>` cache at line 58, `getResolvedPolicy` lazy-loads at
line 96, `startPolicyBustSubscriber` at line 191). Follow that shape.

Put the broker and connection manager beside the existing raw client:

```
packages/api/src/modules/mcp/
  client.ts            (built)  McpRawClient
  protocol.ts          (built)  McpProtocolClient + SDK impl
  connection-manager.ts (new)   live-client cache + state machine + re-hydration
  broker.ts            (new)    McpExecutionBroker (listTools / callTool)
  persistence.ts       (new)    row read/write for mcp_connections / mcp_catalog_revisions
  index.ts             (extend) export the broker/manager singletons
```

### The layering (who calls whom)

```
model -> mcp.call (RegisteredTool, dispatch/index.ts:420 pipeline)
      -> dispatch: Zod envelope (Q2), staging + approval + idempotency (Q3),
         effective-risk resolution (Q5)
      -> tool.execute -> McpExecutionBroker.callTool(ref, args)
      -> ConnectionManager.get(connectionId) -> live McpRawClient
      -> McpRawClient.callTool (exact JSON-Schema validate, revision check,
         result bound) -> remote tools/call
```

The broker interface stays the minimal one from decision-map #3
(`...decision-map.md:102-116`) and the requirements "minimal v1 interfaces"
(`...requirements.md:206-221`). Crucially, **the runtime/model never receives
endpoint URLs, tokens, headers, or the SDK client** (`...requirements.md:223`,
`...decision-map.md:118`): the broker takes `connectionId` + `ExternalToolRef` +
opaque args and returns an `McpCallEnvelope` (`client.ts:36-43`). All transport
detail is confined to the connection manager.

### Connection manager: FACTS in the DB, live client in memory

The connection manager owns a process-lifetime
`Map<connectionId, { client: McpRawClient; state: McpConnectionStatus }>` (mirror
the policy-cache Map). Because rows persist **facts, not live SDK objects**
(`...requirements.md:51`), the manager **re-hydrates a `McpRawClient` on demand**:

```ts
async function hydrate(connectionId: string): Promise<McpRawClient> {
  const row = await readConnection(connectionId);               // persistence.ts
  const client = new McpRawClient({
    connectionId: row.id,
    endpoint: new URL(row.endpointUrl),
    endpointAuthorization: buildEndpointAuthorization(row.endpointOrigin), // SSRF/origin pin owner
    authProvider: row.credentialId ? buildAuthProvider(row.credentialId) : undefined,
    // fetch: hardened fetch wrapper (deferred; see last section)
  });
  await client.connect();                                        // client.ts:113 (pins protocol/tools)
  await client.refreshCatalog();                                 // client.ts:157 (immutable revision)
  return client;
}
```

`McpRawClient` already exposes the exact seams this needs: the
`protocolFactory` injection point (`client.ts:62`, `client.ts:118-119`) and the
`McpEndpointAuthorization` interface (`client.ts:45-51`) — the same seam a fake
uses offline (see last section).

### Who owns the state machine

The **connection manager** owns the `disconnected → connecting → ready → stale →
auth_required → failed` machine (`...requirements.md:41-49`), with two halves:

- **Durable half:** `mcp_connections.status` (Q4) — survives restart, drives the
  UI, and is what a cold worker reads first.
- **Runtime half:** the live `McpRawClient`'s own in-memory state (`#protocol`
  null/non-null at `client.ts:87`, `#catalog` at `client.ts:89`).

Reconciliation rules the manager enforces:

- On `McpClientError("session_expired")` (the client already drops its protocol
  and invalidates the catalog, `client.ts:366-378`), the manager marks the row
  `stale`, evicts the cached client, and re-hydrates on the next call.
- On `notifications/tools/list_changed`, the raw client invalidates its catalog
  (`client.ts:126`, `#invalidateCatalog` at `client.ts:358`); the manager
  refetches, publishes a **new** immutable `mcp_catalog_revisions` row, and
  advances `currentCatalogRevisionId` atomically (never mutates the active
  revision — `...requirements.md:63`). A staged approval bound to the old
  descriptor hash is re-resolved on resume (Q3/Q5).
- Explicit disconnect/revoke → `terminateSession` best-effort (`client.ts:149`,
  tolerate 405), evict, revoke the credential through its owner, set row
  `failed`/`disconnected`.

Cross-instance eviction (a connection edited on another server instance) reuses
the exact Redis PSUBSCRIBE pattern from `resolve.ts:191-229` — e.g.
`mcp-bust:c:<connectionId>`.

---

## 7. Idempotency / timed-out write: durably marking UNKNOWN and never silently retrying

### The existing suppression, and why it does not cover this

- Retry-suppression fires **only for `status='rejected'` rows** and **only
  within the same run** (`dispatch/index.ts:628-660`; the ADR-0034 comment at
  `dispatch/index.ts:626-627` and the partial index at `action-policies.ts:95`
  both scope it to `run_id`).
- A tool that **throws** (a timeout from `McpRawClient.callTool` bubbles as an
  error) is caught by `executeAndCommit` and written as **`status='failed'`**
  with an `executeError` (`dispatch/index.ts:1291-1304`).
- A re-dispatch of the **same `tool_call_id`** onto a `failed` row
  short-circuits and returns the stored error without re-executing
  (`dispatch/index.ts:905-910`). **But** the model can re-propose with a *new*
  `tool_call_id` and identical args → a brand-new staging row → it re-executes,
  because `failed` rows are not in the rejected-retry index. **That is the silent
  retry the requirements forbid** (`...requirements.md:57`, `114`, `234`: a
  timed-out write has unknown outcome and must not be auto-retried).

So `failed` is doubly wrong: it *implies the write did not happen* (untrue — the
outcome is unknown), and it does not stop a fresh-`tool_call_id` retry.

### Recommendation: no new `action_stagings` status; honest `executed` envelope + `mcp_invocation.outcome='unknown'` + broker-level cross-call suppression

1. **The broker catches the timeout/abort and does not let it become a bare
   throw.** Extend `McpCallEnvelope.outcome` (`client.ts:40`) — or the broker's
   own envelope — from `"completed" | "tool_error"` to add `"unknown"`. On
   abort/timeout (advisory cancellation, remote may have applied the write —
   `...requirements.md:57`), the broker returns an envelope
   `{ outcome: "unknown", ... }` with an honest, model-readable message.

2. **Store it as `status='executed'` with the unknown envelope as
   `executeResult`.** This is consistent with ADR-0070's rule that `status` means
   "execution happened," not "the payload is a success"
   (`dispatch/index.ts:1319-1326`). The model then *sees* the unknown outcome
   (result-honesty, ADR-0071 #6 / `decisions.md:3992`) rather than a hidden
   `failed`, and the same-`tool_call_id` replay serves the same unknown envelope
   from the `executed` short-circuit (`dispatch/index.ts:890-903`). **No new
   value in the closed `actionStagingStatusSchema`** (`contracts/actions.ts:3-12`),
   which avoids rippling through result-routing, the approvals UI, and Replicache.
   (This is a real judgment call — see Open Tension #4.)

3. **Durably mark UNKNOWN and block cross-`tool_call_id` retry on the
   `mcp_invocation` row (Q3):**

   ```ts
   mcp_invocation(
     ...,
     outcome text $type<"completed" | "tool_error" | "unknown">,
     args_hash text,          // = proposedInputHash of the mcp.call args
     unique(connection_id, remote_name, args_hash)  // dedup surface
   )
   ```

   Before the broker issues a **write** MCP call, it checks for a prior
   `mcp_invocation` with `outcome='unknown'` for the same
   `(connection_id, remote_name, args_hash)`. If found, it **refuses to
   auto-execute** and returns a visible envelope demanding either a reviewed
   remote-idempotency policy or a read-after-write reconciliation before retry
   (`...requirements.md:114`). This extends the *concept* of retry-suppression
   (currently rejected-only, run-scoped) to *unknown-outcome writes,
   cross-run/cross-`tool_call_id`* — which the existing `action_stagings`
   suppression structurally cannot do.

**Summary:** `failed` + a flag is insufficient (it lies about occurrence and
doesn't block the fresh-`tool_call_id` path). The `DispatchResult` union needs
**no** new arm and the status enum needs **no** new value; the honest-`executed`
envelope carries "unknown" to the model, and the durable non-retry guarantee
lives on `mcp_invocation` enforced by the broker.

---

## Prerequisites vs deferrable-adjacent (for an offline, fake-`McpProtocolClient` slice)

All five are **deferrable** for a persistence + broker slice made testable
offline via the existing `protocolFactory` seam (`client.ts:62`, `118-119`) and
a permissive `McpEndpointAuthorization` (`client.ts:45-51`):

- **OAuth lifecycle — deferrable.** `authProvider` is optional on
  `McpRawClientOptions` (`client.ts:57`); a fake protocol client needs no token.
  Hard prerequisite only for a real protected remote server.
- **Production SSRF / endpoint enforcement — deferrable.** Already abstracted
  behind `McpEndpointAuthorization.authorize` and an injectable `fetch`
  (`client.ts:45-51`, `client.ts:58`); a test supplies a pass-through authorizer.
  Hard prerequisite before any real network egress.
- **Code Mode host binding (ADR-0087) — deferrable.** A separate runtime adapter
  that *consumes* the broker; the broker is fully exercised through the `mcp.call`
  projected tool without it (`...decision-map.md:60-63`).
- **Object-handle parking (ADR-0087) — deferrable.** The raw client already
  bounds results via `boundPassthroughBody` (`client.ts:340`); large-result
  handles are a later optimization gated by the truncation thermometer
  (`decisions.md:4185`), not a correctness prerequisite.
- **Connection-management UI — deferrable.** Connections/revisions can be seeded
  by a test/script; the broker reads rows, not a UI.

The actual hard prerequisites for this slice are only: the two schema tables
(+ `mcp_tool_policy`, `mcp_invocation`), the connection manager + broker, the
`mcp` slug + `mcp.call`/`mcp.list_tools` projection, and the dispatch
effective-risk seam. This matches requirements build-order steps 4–5
(`...requirements.md:247-248`).

---

## Recommended build order for this slice

1. **Contracts:** add `mcp` to `INTEGRATION_SLUGS`/`INTEGRATION_ACTIONS`
   (`call`, `list_tools`), `mcpCallInput`/`mcpListToolsInput` schemas + `TOOL_LABELS`/
   `TOOL_CATEGORIES` entries, and the `McpConnectionStatus` literal union. Verify
   `isToolName` stays closed; add `mcp.call`/`mcp.list_tools` to the tool-schema map.
2. **Schema + migration:** `mcp_connections`, `mcp_catalog_revisions` (immutable),
   `mcp_tool_policy`, `mcp_invocation`; `db:generate` → `db:migrate`; named
   `$inferSelect`/`$inferInsert` exports; barrel export.
3. **Persistence module:** connection/revision read-write; atomic
   publish-new-revision-and-advance-pointer.
4. **Connection manager:** live-client cache + re-hydration from a row +
   state-machine reconciliation + Redis bust subscriber (clone `resolve.ts`).
5. **Broker:** `listTools`/`callTool` over the manager; catalog-revision
   re-resolution; `outcome:"unknown"` on timeout; the cross-call unknown-write
   suppression check against `mcp_invocation`.
6. **Dispatch seam:** register `mcp.call`/`mcp.list_tools` (`execute` → broker);
   `mcp.call` static `riskTier:"high"`; add the effective-risk resolution branch
   (mirror the passthrough recheck at `dispatch/index.ts:492-514`); write the
   companion `mcp_invocation` row alongside the staging commit.
7. **Offline tests:** fake `McpProtocolClient` via `protocolFactory`; prove
   catalog-drift re-approval (Q3), high-floor gate + reviewed downgrade (Q5),
   and timed-out-write-recorded-unknown-not-retried (Q7).

---

## Open tensions to resolve (grill fodder)

**1. `mcp` integration slug vs `system.*` for the projection tool.**
A dedicated `mcp` slug preserves the per-user policy gate (a user can set MCP to
`gated`) **and** the ADR-0069 high floor; but it invents a pseudo-"integration"
that is really N independent connections, and `resolvePolicyMode`
(`resolve.ts:120`) resolves one mode for the whole slug, so all connections
share one autonomy setting. `system.mcp_call` is conceptually cleaner (MCP is
plumbing) but `integration === "system"` forces autonomy
(`dispatch/index.ts:663-664`), collapsing the risk model to "high-floor-only"
with no per-user gate knob. *Trade:* policy granularity + a slightly unnatural
slug vs. conceptual tidiness + losing the user policy lever entirely.

**2. Dynamic effective-risk in dispatch vs. per-remote-tool `RegisteredTool`s.**
Recommendation resolves the tier dynamically for `mcp.call` (a special dispatch
branch for a new tool class). The alternative — mint a real `RegisteredTool` per
remote tool at connect time, each with its own static tier — would reuse the
whole existing gate unchanged, but it **violates the write-once-frozen registry
invariant** (`registry.ts:213-216`, `registerTool` throws on unknown actions
`registry.ts:240-245`) and re-opens the closed-union problem. *Trade:* a
dispatch special-case (asymmetry with every other tool) vs. a mutable registry
and a widened union. This is the sharpest structural fork.

**3. Descriptor hash vs whole catalog revision as the approval/downgrade key.**
The raw client today exposes only a whole-catalog `revision`
(`client.ts:381-384`); binding approvals/downgrades to it is simple but churns
every approval and every downgrade whenever *any* tool in the catalog changes.
Per-descriptor hashing (the `descriptorHashes` column in Q4) is stable across
unrelated changes but needs the client/loader to emit per-tool hashes and more
comparison machinery. *Trade:* implementation simplicity + over-invalidation vs.
extra machinery + precise, low-churn invalidation.

**4. Timed-out write as `status='executed'` (honest unknown envelope) vs a new
`outcome_unknown` status.** `executed` keeps the closed
`actionStagingStatusSchema` (`contracts/actions.ts:3-12`) untouched and shows the
model an honest "unknown" result, but arguably lies about "executed" for a call
whose outcome is genuinely unknown. A 7th status is semantically honest but
ripples through result-routing, the approvals UI, Replicache read models, and
every exhaustive `switch` on status. *Trade:* minimal blast radius + a slightly
loaded word vs. semantic precision + broad churn.

**5. Reuse `integration_credentials` (provider `"mcp"`) vs a dedicated
`mcp_credential` store.** Reuse inherits the existing refresh/rotation/plaintext
machinery (`integrations.ts:34-89`) with one FK, but blurs the
"keep MCP client/server/OAuth roles separate" boundary the lesson insists on
(`.lessons/separate-mcp-client-server-and-oauth-roles.md`) — an
`integration_credentials` row historically means "a downstream provider grant,"
and an MCP-server bearer is a different audience. A dedicated store enforces the
separation in the schema itself at the cost of duplicating rotation logic.
*Trade:* less code + role blur vs. schema-enforced separation + duplication.
(Note: `integration_credentials` still stores tokens plaintext —
`integrations.ts:24-33` — so either way the encryption deferral, #453, applies.)
