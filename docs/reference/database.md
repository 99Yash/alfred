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

`event_receipts` is the one delivery record for every inbound event source (ADR-0090, ADR-0097). An inbound webhook row stores the verified body in `payload` under `provider = <source slug>` and `event_type = <slug>.<type>`; read the type back with `parseEventTypeName` from `@alfred/contracts`. There is no per-source event table: `webhook_events` was dropped in migration 0117 (#975), and a new source must not add a `<source>_events` table. ADR-0097 item 10 adds a derived corpus document for each inbound receipt. Its `source_id` is the receipt id and its `raw` field retains the payload. The table holds two tiers (ADR-0097 item 9, migration 0118). A typed receipt has `raw_kind IS NULL`, its declared dedup key, and a `<slug>.<type>` name the entry declares. A raw receipt is a verified delivery of a kind the entry does not name: `raw_kind` holds the provider's own kind, `event_type` is `<slug>.raw`, `provider_delivery_id` is `raw:<raw_kind>:<payload_hash>`, and the row is `completed` at insert with no job and no bus event. Typed consumers read `typedEventReceipts` from `@alfred/db/schemas`. This view filters `raw_kind IS NULL` before any caller LIMIT and omits the discriminator column. The consolidation gate rejects direct table reads outside the view, insert conflict read-back, raw inventory, and the bounded corpus backfill. Migration 0119 adds this view, checks that the raw marker agrees with `raw_kind`, requires raw rows to be completed with a timestamp, and converts existing raw keys to the kind-and-hash format. The inventory reader `readRawReceiptInventory` selects raw rows through `integration_credentials`, because an integration slug and an event-source slug are different spaces.

## BullMQ / Redis

`createRedisConnection(kind)` from `@alfred/db/redis` is the only factory. `kind` picks what the connection does when Redis is unreachable, refusing, or accepting but unresponsive. Read the kinds off the `RedisConnectionKind` table in `packages/db/src/redis.ts` — it is the single home of that matrix, and a copy here would drift from it. Pass `{ tracked: false }` for a short-lived probe the caller closes itself; every other connection is drained by `closeRedis()` at shutdown.

Never create raw `new IORedis()` in app code; `pnpm check` fails on one.
