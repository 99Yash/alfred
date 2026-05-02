# Alfred — agent orientation

Alfred is a personal AI assistant (single user, multi-device). It connects to email, calendar, and other integrations to run background workflows and answer questions about the user's day.

Read [`decisions.md`](./decisions.md) before proposing architecture changes — 25 ADRs cover every major choice and rejection.

## Commands

```bash
pnpm dev             # start server (:3001) + web (:3000) in watch mode
pnpm build           # build all packages/apps
pnpm check-types     # tsc across all packages
pnpm db:generate     # generate Drizzle migration from schema diff
pnpm db:migrate      # apply pending migrations
pnpm db:studio       # Drizzle Studio GUI
```

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
app.use(authMacro).get("/protected", ({ user }) => user, { auth: true });

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

Model selection: `getBossModel()`, `getSubAgentModel()`, `getCheapModel()` from `@alfred/ai/provider`. Do not call AI SDK provider functions directly from route handlers.

Embeddings: `embed(text, opts?)` from `@alfred/ai/embeddings` — currently a zero-vector stub; real Voyage wiring comes in milestone 7. All embedding dimensions must be 1024.

## BullMQ / Redis

`createRedisConnection()` from `packages/api/src/queue/connection.ts` returns a tracked IORedis connection (closed on shutdown). Use it for BullMQ Queue and Worker constructors.

`createUntrackedRedisConnection()` is for short-lived probes (health checks) — caller must close it.

Never create raw `new IORedis()` in app code; always use these factories.

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

Key vars for local dev (pre-filled in `apps/server/.env`):

| Var                            | Notes                                                  |
| ------------------------------ | ------------------------------------------------------ |
| `DATABASE_URL`                 | Postgres — local docker default already set            |
| `REDIS_URL`                    | Redis — local docker default already set               |
| `BETTER_AUTH_SECRET`           | Min 32 chars — generate with `openssl rand -base64 32` |
| `BETTER_AUTH_URL`              | `http://localhost:3001` for local dev                  |
| `ALFRED_ALLOWED_EMAIL`         | Your email — only address that can sign up             |
| `RESEND_API_KEY`               | Required for OTP email delivery                        |
| `RESEND_FROM_EMAIL`            | e.g. `Alfred <noreply@yourdomain.com>`                 |
| `ANTHROPIC_API_KEY`            | Required — primary LLM                                 |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Required — fallback LLM + Gemini embeddings            |
| `GOOGLE_OAUTH_*`               | Required for m7 Gmail OAuth (client id/secret/redirect)|
| `GOOGLE_PUBSUB_TOPIC`          | m7c — Pub/Sub topic Gmail push publishes to            |
| `GOOGLE_PUBSUB_AUDIENCE`       | m7c — OIDC audience on the push subscription           |

All other vars are optional and safe to leave blank locally.

When adding a new env var: update `packages/env/src/server.ts`, `apps/server/.env`, `.env.example`, and this file.

Do not use `process.env` directly in app code — always go through `serverEnv()`.

## Milestone status

- [x] 1 — Scaffold
- [x] 2 — Auth + first Railway deploy
- [x] 3 — Replicache MVP
- [x] 4 — Realtime stack (outbox → Redis → SSE)
- [x] 5 — Durable agent runtime
- [x] 6 — Cost metering
- [x] 7 — Gmail integration end-to-end (7a OAuth+raw ingest, 7b embeddings+search, 7c poll+webhook code; webhook activation deferred — see [pending-setup.md](./pending-setup.md))
- [ ] 8 — Memory primitives
- [ ] 9 — Email triage workflow
- [ ] 10 — Morning briefing workflow
- [ ] 11 — Cold-start research
- [ ] 12 — Skills + user-authored workflows
- [ ] 13 — Boss + sub-agent orchestration
- [ ] 14 — MCP client
- [ ] 15 — Observability
