# Alfred — agent orientation

Alfred is a personal AI assistant (single user, multi-device). It connects to email, calendar, and other integrations to run background workflows and answer questions about the user's day.

Read [`decisions.md`](./decisions.md) before proposing architecture changes — 25 ADRs cover every major choice and rejection.

One non-standard rule:

- **Never `db:push` outside local exploration.** Always `db:generate` → `db:migrate`.

Workspace packages export TS source directly (`./src/index.ts`), so `pnpm check-types` works on a fresh tree without a prior build.

## Monorepo layout

```
apps/
├── server/          # Elysia HTTP server — port 3001
└── web/             # Vite + TanStack Router SPA — port 3000
packages/
├── ai/              # AI SDK provider config, model dispatcher, embeddings stub
├── api/             # Elysia app (routes + middleware) + Eden App type export
├── auth/            # Better Auth config — emailOTP + one-email allowlist
├── config/          # Shared tsconfig.base.json
├── db/              # Drizzle schema, pool, helpers
├── env/             # Zod-validated env vars — serverEnv() / CLIENT_DEFAULTS
├── sync/            # Replicache mutator stubs (wired in milestone 3)
├── integrations/    # Per-provider shells (Gmail, Calendar, …) — milestone 7
└── ingestion/       # Shared chunker/embedder/dedup helpers — milestone 7
```

All packages are `@alfred/*`. Never import `@milkpod/*`.

## How the pieces coordinate

**Web → API:** `apps/web/src/lib/eden.ts` creates an Eden treaty client typed against `App` from `@alfred/api`. The Vite dev server proxies `/api/auth/*` to `localhost:3001`; all other API calls use `VITE_API_URL` directly.

**Web → Auth:** `apps/web/src/lib/auth-client.ts` creates a Better Auth client with the `emailOTPClient()` plugin. It talks to the Better Auth endpoints mounted on the Elysia server (`/api/auth/*`).

**API → Auth:** `packages/api/src/middleware/session-cache.ts` calls `auth().api.getSession()` with a two-layer cache (per-request WeakMap + 10-second token cache). Import `getSessionCached()` in route handlers; never call `auth()` directly from routes.

**API → DB:** `db()` from `@alfred/db` returns the shared pg pool singleton. Call it inside handlers and workers; do not call it at module init time.

**Server bootstrap:** `apps/server/src/index.ts` awaits `warmPool()` and `initEventBridge()` before binding the port. Graceful shutdown drains Redis then the DB pool on SIGTERM/SIGINT.

## Package boundaries

`@alfred/api` and `@alfred/auth` depend on `@alfred/db` and `@alfred/env`, which pull in Node-only modules (`pg`, `drizzle-orm`). **Never import these packages into `apps/web`'s runtime bundle.**

Allowed in `apps/web`:

- `import type { App } from '@alfred/api'` — type-only, stripped at build time, safe.
- `import { treaty } from '@elysiajs/eden'` — client-side.
- `import { createAuthClient } from 'better-auth/react'` — client-side.

Forbidden in `apps/web`:

- Any non-type import of `@alfred/api`, `@alfred/auth`, `@alfred/db`, `@alfred/env`.
- Any import of `@alfred/ai` (contains server-only AI SDK providers).

Path alias `~/` maps to `src/` in both apps.

## TypeScript conventions

- All packages use `"moduleResolution": "bundler"` and `"verbatimModuleSyntax": true`. Use `import type` for type-only imports.
- `apps/web` uses `tsc --noEmit` for type-checking (not `tsc -b`) — it's a leaf node, not a composite project.
- All other packages use `tsc -b` via composite project references.
- When reading unfamiliar library APIs, inspect type definitions in `node_modules/.pnpm/*/node_modules/<pkg>/dist/*.d.ts` — do not guess from old docs or training data.

## Elysia patterns

Elysia processes requests: `onRequest → transform → beforeHandle → handler → afterHandle → mapResponse → afterResponse`. Errors from any stage after routing jump to `onError`.

Key patterns in this repo:

```ts
// Auth guard via macro (packages/api/src/middleware/auth.ts)
app.use(authMacro).get('/protected', ({ user }) => user, { auth: true });

// Global error handler (packages/api/src/middleware/error-handler.ts)
// Normalises all errors to { error: string, code: string }.
// Throw ApiError subclasses from services; do not set.status manually.

// Session cache (packages/api/src/middleware/session-cache.ts)
// Call getSessionCached(request) — never auth().api.getSession() directly.
```

Plugin scope: hooks registered via `.use(plugin)` apply to routes defined after that call. Use `{ as: 'global' }` on `onError` to catch errors from all plugins.

## Database

Schema lives in `packages/db/src/schema/`. Export everything through `packages/db/src/schemas.ts`.

```bash
# Typical schema change workflow
# 1. Edit packages/db/src/schema/<file>.ts
# 2. pnpm db:generate        ← diff schema → migration SQL
# 3. pnpm db:migrate         ← apply to local DB
# 4. pnpm check-types        ← verify nothing broke
```

Drizzle config reads `DATABASE_URL` from `apps/server/.env`.

`createId(prefix?)` from `packages/db/src/helpers.ts` generates prefixed nanoid IDs (e.g. `createId('usr')` → `usr_abc123`). Use it for all primary keys.

`lifecycle_dates` spread adds `createdAt` / `updatedAt` columns with sane defaults.

## Auth

`packages/auth/src/index.ts` exports `auth()` — the full Better Auth instance with emailOTP and the one-email allowlist hook. Mount it on the Elysia server via `.mount(auth().handler)`.

The allowlist rejects any signup where `user.email !== ALFRED_ALLOWED_EMAIL`. It throws, which Better Auth converts to a 422.

`packages/auth/src/session.ts` exports `sessionAuth()` — a lightweight instance for session-only verification (no emailOTP plugin, no Resend dependency). Used by `session-cache.ts`.

## AI SDK

Alfred uses AI SDK v6 (`ai@^6`). Common v6 differences:

- `maxTokens` → `maxOutputTokens` in `generateText`/`streamText`.
- `maxSteps` → `stopWhen: [stepCountIs(n)]`.
- `tool()` uses `inputSchema`, not `parameters`.
- `LanguageModel` is a union — do not hardcode string model IDs in type positions.
- `generateObject` _@deprecated_ — Use `generateText` with an `output` setting instead.

Model selection: `getBossModel()`, `getSubAgentModel()`, `getCheapModel()`, `getWebSearchModel()`, `getResearchModel()` from `@alfred/ai/provider`. Do not call AI SDK provider functions directly from route handlers. The two web-search models (Perplexity Sonar Pro for live, Sonar Deep Research for cold-start) must be routed through `meteredGenerateText` with `attribution.kind = 'web_search'` so cost rollups bucket them apart from the LLM line.

Embeddings: `embed(text, opts?)` from `@alfred/ai/embeddings` — currently a zero-vector stub; real Voyage wiring comes in milestone 7. All embedding dimensions must be 1024.

## BullMQ / Redis

`createRedisConnection()` from `packages/api/src/queue/connection.ts` returns a tracked IORedis connection (closed on shutdown). Use it for BullMQ Queue and Worker constructors.

`createUntrackedRedisConnection()` is for short-lived probes (health checks) — caller must close it.

Never create raw `new IORedis()` in app code; always use these factories.

## Domain pipelines

Per-feature operational details live alongside the code orientation here:

- **Email triage (m9)** — Gmail-message classification + label write-back. See [`docs/triage.md`](./docs/triage.md).
- **Morning briefing (m10)** — daily inbox-only digest via `notify()` + Resend. See [`docs/briefing.md`](./docs/briefing.md).
- **Cold-start research (m11)** — one-shot Perplexity Sonar Deep Research at signup, lifetime-once per user. See [`docs/cold-start.md`](./docs/cold-start.md).

## Replicache

`packages/sync` ships the client-side mutators (currently `noteCreate`) and shared key helpers. Server-side push/pull/poke endpoints live at `/api/replicache/{push,pull,events}` (see `packages/api/src/modules/replicache/`). Pokes flow over Redis Pub/Sub on `replicache-pokes:u:<userId>` channels and reach the browser via SSE.

When adding a new synced entity:

1. Add an entry to `IDB_KEY` in `packages/sync/src/keys.ts` — one function that returns the prefix when called with `{}` and a single-row key when called with `{ id }`. The slug here drives every generic dispatcher downstream.
2. Define the read shape in `packages/sync/src/types.ts` (must include `rowVersion: number`).
3. Add `<entity><Action>Client` mutator + zod arg schema in `packages/sync/src/mutators/<entity>.ts`, register both in `mutators/index.ts` (`clientMutators` + `mutatorArgsSchemas`).
4. Add the matching server-side mutator in `packages/api/src/modules/replicache/server-mutators.ts` — write against the supplied `tx` (so it commits inside the push handler's outer transaction) and bump `row_version`. Pokes fire generically from the push handler after commit.
5. Add a fetcher to `ENTITY_FETCHERS` in `packages/api/src/modules/replicache/pull.ts` returning `{ id, rowVersion, serialized }` per row. The CVR snapshot shape (`Partial<Record<IDBKeys, ClientViewMap>>`) is generic — no `cvr.ts` change needed.

## Environment variables

Validated by `serverEnv()` from `@alfred/env/server`. Calling it with missing vars throws a clear error listing what's missing.

Key vars for local dev should be pre-filled in `apps/server/.env`

Some vars are optional and safe to leave blank locally.

When adding a new env var: update `packages/env/src/server.ts`, `apps/server/.env`, `.env.example`, and this file.

Do not use `process.env` directly in app code — always go through `serverEnv()`.

## Milestone status

- 1 — Scaffold
- 2 — Auth + first Railway deploy
- 3 — Replicache MVP
- 4 — Realtime stack (outbox → Redis → SSE)
- 5 — Durable agent runtime
- 6 — Cost metering
- 7 — Gmail integration end-to-end (7a OAuth+raw ingest, 7b embeddings+search, 7c poll+webhook code; webhook activation deferred — see [pending-setup.md](./pending-setup.md))
- 8 — Memory primitives
- 9 — Email triage workflow (9a schema + Gmail label plumbing, 9b classifier + workflow, 9c trigger from poll_history, 9d smoke-triage)
- 10 — Morning briefing workflow (10-pre per-feature scope sets + requireScopes; 10a email_sends + notify(); 10b morning-briefing workflow; 10c hourly briefing.tick + tz resolution; 10d smoke-briefing). Inbox-only at v1; calendar deferred.
- 11 — Cold-start research at signup (11a `getResearchModel()` + Perplexity Sonar Deep Research wired through `meteredGenerateText` with `kind='web_search'`; 11b `packages/api/src/modules/cold-start/` — signal collector, research call, cheap-tier extractor, dedup; 11c `cold-start-research` builtin workflow with steps `gather-signals` → `research` → `extract-facts` → `persist`; 11d trigger from `google-routes.ts` `/callback` gated by `hasPriorColdStartRun` so a re-connect doesn't re-run; 11e `smoke-cold-start.ts`). Signals are extensible per-integration — Google contributes `accountEmail` today; future GitHub/etc. integrations plug into `collectColdStartSignals` without workflow change. v1 trigger fires from the OAuth callback because Google is currently the only integration that contributes signals beyond the user row; revisit once another integration lands.
- 12 — Skills + user-authored workflows: authoring surface + trigger dispatch only; execution deferred to m13 per ADR-0017 + ADR-0027. Brief-only authoring (no DAG editor), `cron` + `manual` triggers live, `event`/`on_signal` UI-disabled until m13. Execution stub: `createRun` for `is_builtin=false` lands as `failed` with reason `user_authored_brief_execution_pending_m13`. See [`CONTEXT.md`](./CONTEXT.md) for the locked m12 scope and ADR-0027 for the trigger-dispatch design.
- 13 — Boss + sub-agent orchestration. Replaces m12's execution stub. Builds the tool registry + tool dispatcher + `load_integration` + `AlfredAgent`→runtime bridge + sub-agent spawning + `event`/`on_signal` dispatchers all in one pass (ADRs 0016, 0026).
- 14 — MCP client
- 15 — Observability
