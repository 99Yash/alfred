# Database & queues

## Database

**Never `db:push` outside local exploration.** Always `db:generate` → `db:migrate`.

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

`db()` from `@alfred/db` returns the shared pg pool singleton. Call it inside handlers and workers; do not call it at module init time.

## BullMQ / Redis

`createRedisConnection()` from `packages/api/src/queue/connection.ts` returns a tracked IORedis connection (closed on shutdown). Use it for BullMQ Queue and Worker constructors.

`createUntrackedRedisConnection()` is for short-lived probes (health checks) — caller must close it.

Never create raw `new IORedis()` in app code; always use these factories.
