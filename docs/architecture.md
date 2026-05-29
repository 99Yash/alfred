# Architecture

## Monorepo layout

```
apps/
├── server/          # Elysia HTTP server — port 3001
└── web/             # Vite + TanStack Router SPA — port 3000
packages/
├── ai/              # AI SDK provider config, model dispatchers, embeddings, metering
├── api/             # Elysia app (routes + middleware) + Eden App type export
├── auth/            # Better Auth config — Google social provider + one-email allowlist
├── config/          # Shared tsconfig.base.json
├── contracts/       # Zero-dep shared types + consts (tool registry, runtime keys) — safe in apps/web
├── db/              # Drizzle schema, pool, helpers
├── env/             # Zod-validated env vars — serverEnv() / CLIENT_DEFAULTS
├── schemas/         # Browser-safe shared Zod schemas + inferred types
├── sync/            # Replicache keys, schemas, and client mutators
├── integrations/    # Per-provider integration code (Gmail, Calendar, GitHub, ...)
└── ingestion/       # Shared chunker/embedder/dedup helpers
```

All packages are `@alfred/*`. Never import `@milkpod/*`.

Path alias `~/` maps to `src/` in both apps.

## How the pieces coordinate

**Web → API:** `apps/web/src/lib/eden.ts` creates an Eden treaty client typed against `App` from `@alfred/api`. The Vite dev server proxies `/api/auth/*` to `localhost:3001`; all other API calls use `VITE_API_URL` directly.

**Web → Auth:** `apps/web/src/lib/auth-client.ts` creates a Better Auth client. The web app calls `authClient.signIn.social({ provider: "google" })` from the login surface; Better Auth redirects through Google and back to `/api/auth/callback/google`, both mounted on the Elysia server.

**API → Auth:** `packages/api/src/middleware/session-cache.ts` calls `auth().api.getSession()` with a two-layer cache (per-request WeakMap + 10-second token cache). Import `getSessionCached()` in route handlers; never call `auth()` directly from routes.

**API → DB:** `db()` from `@alfred/db` returns the shared pg pool singleton. Call it inside handlers and workers; do not call it at module init time.

**Server bootstrap:** `apps/server/src/index.ts` awaits `warmPool()` and `initEventBridge()` before binding the port. Graceful shutdown drains Redis then the DB pool on SIGTERM/SIGINT.

## Package boundaries

`@alfred/api` and `@alfred/auth` depend on `@alfred/db` and `@alfred/env`, which pull in Node-only modules (`pg`, `drizzle-orm`). **Never import these packages into `apps/web`'s runtime bundle.**

Allowed in `apps/web`:

- `import type { App } from '@alfred/api'` — type-only, stripped at build time, safe.
- `import { ... } from '@alfred/contracts'` — zero Node deps (pure types + const exports), safe at runtime.
- `import { ... } from '@alfred/schemas'` — browser-safe Zod schemas and inferred types.
- `import { ... } from '@alfred/sync'` — Replicache keys, mutators, and synced read-model schemas.
- `import { treaty } from '@elysiajs/eden'` — client-side.
- `import { createAuthClient } from 'better-auth/react'` — client-side.

Forbidden in `apps/web`:

- Any non-type import of `@alfred/api`, `@alfred/auth`, `@alfred/db`, `@alfred/env`.
- Any import of `@alfred/ai` (contains server-only AI SDK providers).

`pnpm check:web-boundaries` enforces these forbidden runtime imports for `apps/web`.

## Environment variables

Validated by `serverEnv()` from `@alfred/env/server`. Calling it with missing vars throws a clear error listing what's missing.

Key vars for local dev should be pre-filled in `apps/server/.env`. Some vars are optional and safe to leave blank locally.

Do not use `process.env` directly in app code — always go through `serverEnv()`.

When adding a new env var: update `packages/env/src/server.ts`, `apps/server/.env`, `.env.example`, and this doc.
