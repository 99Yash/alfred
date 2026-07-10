# Architecture

## Monorepo layout

```
apps/
├── server/          # Elysia HTTP server — port 3001
└── web/             # Vite + TanStack Router SPA — port 3000
packages/
├── ai/              # AI SDK provider config, model dispatchers, embeddings, metering
├── api/             # HTTP root + backend service and runtime entrypoints
├── artifacts-design/ # Shared artifact themes and design contracts
├── auth/            # Better Auth config — Google social provider + one-email allowlist
├── config/          # Shared tsconfig.base.json
├── contracts/       # Browser-safe shared types, consts, and Zod schemas
├── db/              # Drizzle schema, pool, helpers
├── env/             # Zod-validated env vars — serverEnv() / CLIENT_DEFAULTS
├── sync/            # Replicache keys, schemas, and client mutators
├── integrations/    # Per-provider integration code (Gmail, Calendar, GitHub, ...)
├── mailer/          # React Email templates + render helpers for Resend sends
└── ingestion/       # Shared chunker/embedder/dedup helpers
```

All packages are `@alfred/*`. Never import `@milkpod/*`.

Path alias `~/` maps to `src/` in both apps.

## How the pieces coordinate

**Web → API:** `apps/web/src/lib/eden.ts` creates an Eden treaty client typed against `App` from `@alfred/api`. The Vite dev server proxies `/api/auth/*` to `localhost:3001`; all other API calls use `VITE_API_URL` directly.

**API entrypoints:** the `@alfred/api` root exports the composed Elysia `app`, its `App` type, and HTTP security-header helpers. Reusable server-side domain and queue services live at `@alfred/api/backend`. Worker lifecycle, registration, scheduling, bootstrap, and teardown operations live at `@alfred/api/runtime`. Supported deep imports are limited to the operational triage and queue paths declared in `packages/api/package.json`.

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
