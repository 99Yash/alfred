# Alfred

Personal assistant agent. Single user (me), multi-device via Replicache.

## Architecture

See `decisions.md` for all 25 ADRs. See `scaffolding-plan.md` for the milestone implementation order.

## Monorepo layout

| Path | Purpose |
|------|---------|
| `apps/server` | Elysia API, port 3001 |
| `apps/web` | Vite + TanStack Router SPA, port 3000 |
| `packages/ai` | AI SDK helpers, model dispatcher, embeddings |
| `packages/api` | Elysia routes + Eden App type |
| `packages/auth` | Better Auth (emailOTP + passkey, one-email allowlist) |
| `packages/config` | Shared tsconfig base |
| `packages/db` | Drizzle schema + migrations |
| `packages/env` | Env-var validation (Zod) |
| `packages/sync` | Replicache mutators + types |
| `packages/integrations` | Per-provider OAuth, live tools, ingestors |
| `packages/ingestion` | Shared chunker, embedder, dedup helpers |

## Namespace

All packages are `@alfred/*`. Never use `@milkpod/*`.

## Local dev setup

```bash
# 1. Start Postgres + Redis
docker-compose up -d

# 2. Create apps/server/.env from .env.example and fill in values
cp .env.example apps/server/.env

# 3. Install deps
pnpm install

# 4. Build packages (required before type-checking)
pnpm build

# 5. Generate + apply DB migrations
pnpm db:generate
pnpm db:migrate

# 6. Start dev servers
pnpm dev
```

## Important conventions

- **Build before type-check**: `pnpm build` before `pnpm check-types` — downstream packages resolve types from `dist/`. Stale `.d.ts` files cause phantom type errors.
- **Package imports**: `apps/web` only imports `@alfred/api` types via Eden client (`import type { App }`), never directly reaches into server-only modules.
- **Server-only modules**: any module that must not run in the browser should be `server-only` protected.
- **Drizzle migrations**: `pnpm db:generate` then `pnpm db:migrate`. Never `db:push` in production.
- **pgvector**: the `pgvector/pgvector:pg17` Docker image pre-installs the extension. For Railway, enable it via `CREATE EXTENSION IF NOT EXISTS vector;` in the first migration.
- **Auth allowlist**: only the email in `ALFRED_ALLOWED_EMAIL` env var can sign up. Enforced in the Better Auth signup hook.

## Milestone status

- [x] Milestone 1 — Scaffold
- [ ] Milestone 2 — Auth + first deploy
- [ ] Milestone 3 — Replicache MVP
- [ ] Milestone 4 — Realtime stack
- [ ] Milestone 5 — Durable agent runtime
- [ ] Milestone 6 — Cost metering
- [ ] Milestone 7 — Gmail integration end-to-end
- [ ] Milestone 8 — Memory primitives
- [ ] Milestone 9 — Email triage workflow
- [ ] Milestone 10 — Morning briefing workflow
- [ ] Milestone 11 — Cold-start research
- [ ] Milestone 12 — Skills + user-authored workflows
- [ ] Milestone 13 — Boss + sub-agent orchestration
- [ ] Milestone 14 — MCP client
- [ ] Milestone 15 — Observability
