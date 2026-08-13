# Architecture

## Monorepo layout

Two apps — `server` (Elysia HTTP, port 3001) and `web` (Vite + TanStack Router
SPA, port 3000). For the package list, run `ls packages/`. The load-bearing
packages (`ai`, `api`, `contracts`, `db`, `http`, `integrations`, `sync`) each carry an
agent guide stating what they own — that ownership rule is the thing a directory
listing cannot tell you.

All packages are `@alfred/*`. Never import `@milkpod/*`.

Path alias `~/` maps to `src/` in both apps.

## How the pieces coordinate

**Web → HTTP:** `apps/web/src/lib/eden.ts` creates an Eden treaty client typed against `App` from `@alfred/http`. The Vite dev server proxies `/api/auth/*` to `localhost:3001`; all other API calls use `VITE_API_URL` directly.

**HTTP and API entrypoints during migration:** the `@alfred/http` root exports
the composed Elysia `app`, its derived `App` type, middleware, and routes. Reusable
server-side domain and queue behavior still lives at `@alfred/api/backend`.
Worker lifecycle, registration, scheduling, bootstrap, and teardown operations
now live behind `createAssistantRuntime` at `@alfred/assistant/runtime`. A host
process builds one runtime and drives `start` and `stop`; the runtime adapters,
the queues, and the workers stay private to that package. `@alfred/api/runtime`
keeps a re-export door for operational scripts. These are legacy doors, not the
target interface.

ADR-0089 moves product behavior and runtime composition to
`@alfred/assistant`, moves HTTP adaptation to `@alfred/http`, and then deletes
the legacy `@alfred/api` package. The migration breaks module cycles in place
before it extracts either target package. See the
[active structure plan](../plans/agent-friendly-module-structure.md).

During Phase 1, application domain events enter through
`publishDomainEvent` in the `@alfred/assistant/triggers`
interface. Producers call this named seam without importing consumers.
`packages/assistant/src/runtime/adapters/trigger-consumers.ts` wires the workflow trigger
consumer before background workers start. Gmail ingestion also treats a
missing consumer as a fatal composition error instead of swallowing it as an
event-level delivery failure. In this name,
“trigger” is the published domain occurrence, not a workflow trigger
definition or schedule; automation still owns those. The current single
consumer attempts its durable workflow occurrence claims before publication
returns. It reports per-workflow failures internally instead of rejecting the
publication call. Durable delivery to several independent consumers is not
complete. Realtime outbox and SSE updates use the separate `publishEvent`
interface.

Google OAuth draft recovery enters through `resolveWorkflowRecoveryTarget` in
the ingestion module (`@alfred/assistant/connections/ingestion`). Runtime
composition registers a workflow adapter that
maps workflow revalidation to the connection-facing `ready`, `blocked`, or
typed-failure result. The connections routes own the HTTP redirect; the ingestion
module does not import the workflow implementation.

Gmail post-insert repair enters through `runGmailPostInsertTriage`, and queued
label reconciliation enters through `runGmailTriageRelabel`. Runtime composition
registers one triage adapter for both operations before ingestion workers start.
The ingestion queue owns provider polling, insert ordering, reply event identity,
and BullMQ retry behavior. Triage owns live-thread repair, relabel queueing, and
the mailbox-write gate. Requests and adapter results are validated at the
ingestion-owned interface, so ingestion does not import the triage
implementation.

Gmail post-insert observation capture enters through `captureGmailObservations`,
and the queued kind projection refresh enters through
`refoldGmailKindProjection`. Runtime composition registers one user-model adapter
before ingestion workers start. The adapter owns document loading in 1,000-row
query chunks, reduction, observation-family append behavior, issue accounting,
the decision to schedule a refold, and active-projection sweep selection. The
ingestion queue still owns BullMQ transport, deduplication, retry, and retention
settings. Capture failures remain best-effort, while missing composition and
refold failures reject the ingestion job so worker retry and monitoring remain
effective.

Chat attachment enrichment scheduling and chat-media ingestion jobs enter
through the ingestion-owned chat-media interface. Runtime composition
registers one chat adapter before ingestion workers start. The adapter owns the
attachment claim and enqueue-failure transition, enrichment behavior, object
storage checks and deletion, and durable-key lookup for pending-upload cleanup.
The ingestion queue owns BullMQ job envelopes, delay, deduplication, retry, and
retention settings. Missing composition and processing failures reject the job
so worker retry and monitoring remain effective. Pending-upload cleanup and
durable attachment creation take the same transaction-scoped advisory lock for
each storage key, so cleanup cannot delete an object after its attachment row
commits.

Google credential connect and disconnect mutations enter through the
integrations-owned credential lifecycle interface. Runtime composition owns the
cross-domain transaction: a credential upsert commits with its organization-
affiliation observations, and a credential delete commits with its disconnect
observation. The complete transaction retries up to three times for recognized
observation-chain conflicts. Disconnect uses the deleted row as evidence, so a
losing delete appends no observation. Remote Gmail watch shutdown remains
best-effort and starts only after the credential transaction commits.

MCP owns its authenticated connection routes, public OAuth metadata and
callback routes, persistence behavior, and runtime connection manager. The HTTP
composition root mounts this presentation directly. The integrations route
aggregate does not import or mount MCP implementation details. MCP uses the
connections interface (`@alfred/assistant/connections`) for the shared signed
OAuth state and nonce store.

**Web → Auth:** `apps/web/src/lib/auth-client.ts` creates a Better Auth client. The web app calls `authClient.signIn.social({ provider: "google" })` from the login surface; Better Auth redirects through Google and back to `/api/auth/callback/google`, both mounted on the Elysia server.

**HTTP → Auth:** `packages/http/src/middleware/session-cache.ts` calls `auth().api.getSession()` with a two-layer cache (per-request WeakMap + 10-second token cache). Import `getSessionCached()` in route handlers; never call `auth()` directly from routes. The root app delegates its final Better Auth mount through a request-time wrapper so importing `@alfred/http` stays environment-free.

**API → DB:** `db()` from `@alfred/db` returns the shared pg pool singleton. Call it inside handlers and workers; do not call it at module init time.

**Server bootstrap:** `apps/server/src/index.ts` warms the DB pool, verifies metering model metadata, starts the outbox/SSE bridge, starts the Replicache poke bridge, registers built-in workflows/tools, starts BullMQ workers, schedules repeatable jobs, then binds the port. Graceful shutdown stops workers before draining Redis and the DB pool on SIGTERM/SIGINT.

## Package boundaries

The server-side packages reach Node-only modules (`pg`, `drizzle-orm`) transitively. **Never import them into `apps/web`'s runtime bundle.** They are enumerated once, in the marked block below — this paragraph deliberately names none of them, because a second enumeration is a second thing to keep true and nothing gates prose outside the markers.

Allowed in `apps/web`: <!-- browser-safe-packages:start -->

- `import type { App } from '@alfred/http'` — type-only, stripped at build time, safe.
- `import { ... } from '@alfred/contracts'` — browser-safe shared Zod schemas, inferred types, constants, and small boundary helpers.
- `import { ... } from '@alfred/sync'` — Replicache keys, mutators, and synced read-model schemas.
- `import { treaty } from '@elysiajs/eden'` — client-side.
- `import { createAuthClient } from 'better-auth/react'` — client-side.

<!-- browser-safe-packages:end -->

Forbidden in `apps/web`: <!-- forbidden-runtime-packages:start -->

- Any non-type import of `@alfred/api`, `@alfred/http`, `@alfred/auth`, `@alfred/db`, `@alfred/env`.
- Any non-type import of `@alfred/ai` (contains server-only AI SDK providers).

<!-- forbidden-runtime-packages:end -->

`pnpm check:web-boundaries` enforces these forbidden runtime imports for the `src/` of every app declared
browser-bound, and for the `src/` of every workspace that the browser bundle reaches from there. It derives
that surface by following runtime `@alfred/*` bindings out of the declared apps, so a package that joins the
bundle joins the check in the same commit. It reads import statements rather than lines: a specifier that a
comment, a quoted string or a template literal only mentions binds nothing, so it neither reports a
violation nor pulls a package into the surface.

Which apps reach a browser bundle is declared by hand, in `BROWSER_ENTRY_APPS` and `NODE_ONLY_APPS` in
[`scripts/web-boundaries.mjs`](../../scripts/web-boundaries.mjs). Workspaces are enumerated from
`pnpm-workspace.yaml`, so a workspace under `apps/` that neither set names is a reported failure, and so is
a declared browser app that the enumeration no longer lists. `apps/*` is never walked as a browser root by
directory: `apps/server` takes runtime `@alfred/db` and `@alfred/env` bindings by design, so a
directory-wide fence there would need a suppression list. The classification itself is not enforced — an app
filed under `NODE_ONLY_APPS` leaves the fence narrow, and the only check against that is that a Node-only
app holding an `index.html` is reported.

One thing stays outside the derived surface, deliberately: any subtree of a reached package that sits
outside its `src/`, because reachability is recorded per package and read at that one directory. A reached
package whose `src/` is missing, or holds no TypeScript file, is not one of these — the check reports it as a
failure instead of skipping it.

Node-only **npm** packages are outside the source fence too, because it reads specifiers and a transitive
npm dependency is written down nowhere in browser code. `pnpm check:web-bundle-graph` closes that half by
asking vite for `apps/web`'s real module graph, so it rules on resolution rather than on source text. It
forbids every package that a workspace outside the browser surface declares as a dependency, minus a short
declared list of genuinely shared ones, plus the same forbidden set above; it fails on the stub id vite
resolves an externalized Node builtin to; and it requires every workspace TypeScript module in the bundle to
be a file the source fence scans, which is the only thing in the repo that could detect a hole in that
fence. The two checks are additive and neither replaces the other: the fence scans 466 files and the graph
holds 425, and the difference is preview and debug routes plus not-yet-imported components, which an
entry-seeded graph cannot see by construction. The graph check is CI-only, as a step in the
`web-unit-tests` job, because it costs a second `vite build`.
The check also rules on the marked prose above and in
[`apps/web/AGENTS.md`](../../apps/web/AGENTS.md). Each site marks two regions. The
`forbidden-runtime-packages` region must name exactly the set in
[`scripts/web-boundaries.mjs`](../../scripts/web-boundaries.mjs); the `browser-safe-packages` region must
name none of it. Membership is all that is compared, so rewording, reordering or repunctuating either list
is free. A region spans whole lines — the `:start` marker ends its line and the `:end` marker opens its own
— and every backticked `@alfred/*` package name in the markdown list that holds a region must sit inside
one of the two regions, so a package named in a sibling bullet is ruled on rather than ignored. A package
name inside a longer code span, such as `import type { App } from '@alfred/http'` above, is not one of those
names.

## Architecture enforcement

`pnpm check:architecture` scans source imports and checks the package graph, the
assistant-module graph, and route-private web features. The committed baseline is
[`scripts/module-architecture-baseline.json`](../../scripts/module-architecture-baseline.json).
It records current debt so the checker permits the list to shrink but does not
permit a new cyclic edge or private cross-module import. The two recorded graphs
are a record of the whole graph, but the checker consults them for their cyclic
subset only. An acyclic recorded edge is therefore a record and not a permission:
the day that edge joins a cycle, the checker reports it.

Each recorded graph also declares the cycles it records, in its `sccs` list. The
checker rejects a baseline whose two lists disagree, in either direction: a
recorded edge set that forms a component the `sccs` list does not declare, and an
`sccs` list that declares a component the recorded edges do not form. So a
recorded graph cannot permit a cycle it does not name.

Use `pnpm check:architecture -- --print-graph` to print the current stable graph.
Use `pnpm check:architecture -- --write-baseline` to regenerate the baseline file.
That command writes the baseline file itself. It prints the added and removed entries
to standard error, and it prints nothing to standard output. The command refuses to
write, and exits with status 1, when the current tree fails the check, and when the
baseline file is absent, is not valid JSON, does not hold every ratchet list as a
list of key strings, does not hold a declared cycle list for each recorded graph, or
permits a cycle it does not declare. Each refusal names its cause. A refusal that
reads a damaged baseline file also names the command that restores it.

One writer at a time cannot widen a permitted set, because the command only writes
from a tree the checker already accepts. Two writers could. Two branches that each
regenerate from an accepted tree merge into a file whose recorded edges hold a cycle
neither branch recorded, because the two edge keys sort far apart in the file and git
merges both without a conflict. The two recorded graphs grow freely and their
permission is a non-monotone function of the record, so their union is not safe the
way the shrink-only exception lists are.

The declared cycle lists close this. Both branches write `sccs` and `edges` from one
snapshot of one accepted tree, so each branch declares no new cycle, while the merged
`edges` lists form one. The merged file therefore contradicts itself, and every path
that reads it refuses, including the check that runs on the merge result in CI. You do
not need to rebase and regenerate before you merge, and no merge tool has to help. The
repository also marks the baseline file `-merge` in `.gitattributes`, which makes a
local `git merge` of two regenerated baselines report a conflict instead of merging
them silently. That is a convenience for the person doing the merge. It is not the
guard, and a merge performed by a service that ignores the attribute is still caught by
the check.

Do not update the baseline to make a failure disappear. Change it only when an
accepted ADR changes the target structure or when a path rename preserves an
existing exception. These two edits are the only legitimate ones, and the refusal
message names both. Every exception needs an owner, a reason, and a removal
phase.

The local verification levels are:

- `pnpm verify:fast`: architecture, boundaries, static checks, format, and types.
- `pnpm verify`: `verify:fast` plus deterministic package tests.
- `pnpm verify:db`: migrations plus API tests with Postgres and Redis available.

All three commands do not change repository files. `pnpm format` is the
explicit formatting command that writes files.

## Web organization

- Keep TanStack route entry files thin: route declaration, parameter/search validation, loaders, and feature composition.
- Colocate feature components, hooks, state, schemas, and helpers in the owning private route directory (for example, `routes/-chat`, `routes/-skills`, or `routes/-integrations`). Put code in top-level `components`, `hooks`, or `lib` only when it is genuinely generic or shared across features.
- Keep preview and debug fixtures inside their preview/debug feature directories. Preview surfaces may compose production components, but production routes and features must not import preview fixtures, route modules, or debug-only helpers.
- Preview and debug surfaces must not trigger production writes, background work, analytics, or provider calls; gate internal routes from production where appropriate.

## Integration status

Live backends today:

- Google Workspace: Gmail, Calendar, Drive, Docs, Sheets, Slides.
- GitHub App: install + user-to-server OAuth, installation tokens for REST, prod-only webhooks.
- Notion OAuth.
- Railway token connect.
- Vercel OAuth.

Catalog/design-only today: Slack and Linear. The web catalog can render those providers, but there are no backend routes or tools for them yet.

## Environment variables

Validated by `serverEnv()` from `@alfred/env/server`. Calling it with missing vars throws a clear error listing what's missing.

`apps/server` loads `apps/server/.env`; `apps/web` loads browser-safe `VITE_*` keys from `apps/web/.env`. The root `.env.example` is the combined reference template.

Do not use `process.env` directly in app code — always go through `serverEnv()`.

When adding a new server env var: update `packages/env/src/server.ts`, `.env.example`, and this doc. When adding a browser env var, update `apps/web/src/vite-env.d.ts`, `.env.example`, and the web code that reads `import.meta.env`.

`ENTITY_ID_NAMESPACE` (ADR-0067) deserves a callout: it is the HMAC namespace for content-addressed stable entity IDs. Optional during P0 (no projection writes IDs yet), but the P1 projection must fail closed if it is absent, and it must be backed up like an auth secret — changing it remints every stable entity ID on replay, dangling every external reference to those IDs.
