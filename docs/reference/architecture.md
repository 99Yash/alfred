# Architecture

## Monorepo layout

Two apps — `server` (Elysia HTTP, port 3001) and `web` (Vite + TanStack Router
SPA, port 3000). For the package list, run `ls packages/`. The load-bearing
packages (`ai`, `api`, `contracts`, `db`, `integrations`, `sync`) each carry an
agent guide stating what they own — that ownership rule is the thing a directory
listing cannot tell you.

All packages are `@alfred/*`. Never import `@milkpod/*`.

Path alias `~/` maps to `src/` in both apps.

## How the pieces coordinate

**Web → API:** `apps/web/src/lib/eden.ts` creates an Eden treaty client typed against `App` from `@alfred/api`. The Vite dev server proxies `/api/auth/*` to `localhost:3001`; all other API calls use `VITE_API_URL` directly.

**API entrypoints during migration:** the `@alfred/api` root exports the composed
Elysia `app`, its `App` type, and HTTP security-header helpers. Reusable
server-side domain and queue behavior still lives at `@alfred/api/backend`.
Worker lifecycle, registration, scheduling, bootstrap, and teardown operations
still live at `@alfred/api/runtime`. These are legacy doors, not the target
interface.

ADR-0089 moves product behavior and runtime composition to
`@alfred/assistant`, moves HTTP adaptation to `@alfred/http`, and then deletes
the legacy `@alfred/api` package. The migration breaks module cycles in place
before it extracts either target package. See the
[active structure plan](../plans/agent-friendly-module-structure.md).

During Phase 1, application domain events enter through the in-place
`packages/api/src/modules/triggers` interface. Producers publish there without
importing consumers. `packages/api/src/composition/trigger-consumers.ts` wires
the workflow trigger consumer before background workers start. In this name,
“trigger” is the published domain occurrence, not a workflow trigger
definition or schedule; automation still owns those. The current single
consumer attempts its durable workflow occurrence claims before publication
returns. It reports per-workflow failures internally instead of rejecting the
publication call. Durable delivery to several independent consumers is not complete.
The older
`packages/api/src/events` tree remains the transport-specific realtime outbox,
SSE, and Replicache poke implementation; it is not the domain trigger interface.

**Web → Auth:** `apps/web/src/lib/auth-client.ts` creates a Better Auth client. The web app calls `authClient.signIn.social({ provider: "google" })` from the login surface; Better Auth redirects through Google and back to `/api/auth/callback/google`, both mounted on the Elysia server.

**API → Auth:** `packages/api/src/middleware/session-cache.ts` calls `auth().api.getSession()` with a two-layer cache (per-request WeakMap + 10-second token cache). Import `getSessionCached()` in route handlers; never call `auth()` directly from routes.

**API → DB:** `db()` from `@alfred/db` returns the shared pg pool singleton. Call it inside handlers and workers; do not call it at module init time.

**Server bootstrap:** `apps/server/src/index.ts` warms the DB pool, verifies metering model metadata, starts the outbox/SSE bridge, starts the Replicache poke bridge, registers built-in workflows/tools, starts BullMQ workers, schedules repeatable jobs, then binds the port. Graceful shutdown stops workers before draining Redis and the DB pool on SIGTERM/SIGINT.

## Package boundaries

`@alfred/api` and `@alfred/auth` depend on `@alfred/db` and `@alfred/env`, which pull in Node-only modules (`pg`, `drizzle-orm`). **Never import these packages into `apps/web`'s runtime bundle.**

Allowed in `apps/web`:

- `import type { App } from '@alfred/api'` — type-only, stripped at build time, safe.
- `import { ... } from '@alfred/contracts'` — browser-safe shared Zod schemas, inferred types, constants, and small boundary helpers.
- `import { ... } from '@alfred/sync'` — Replicache keys, mutators, and synced read-model schemas.
- `import { treaty } from '@elysiajs/eden'` — client-side.
- `import { createAuthClient } from 'better-auth/react'` — client-side.

Forbidden in `apps/web`:

- Any non-type import of `@alfred/api`, `@alfred/auth`, `@alfred/db`, `@alfred/env`.
- Any import of `@alfred/ai` (contains server-only AI SDK providers).

`pnpm check:web-boundaries` enforces these forbidden runtime imports for `apps/web`.

## Architecture enforcement

`pnpm check:architecture` scans source imports and checks the package graph, the
assistant-module graph, and route-private web features. The committed baseline is
[`scripts/module-architecture-baseline.json`](../../scripts/module-architecture-baseline.json).
It records current debt so the checker permits the list to shrink but does not
permit a new cyclic edge or private cross-module import.

Use `pnpm check:architecture -- --print-graph` to print the current stable graph.
Do not update the baseline to make a failure disappear. Change it only when an
accepted ADR changes the target structure or when a path rename preserves an
existing exception. Every exception needs an owner, a reason, and a removal
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
