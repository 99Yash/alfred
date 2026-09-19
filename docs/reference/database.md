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

`event_receipts` is the one delivery record for every inbound event source (ADR-0090, ADR-0097). An inbound webhook row stores the verified body in `payload` under `provider = <source slug>` and `event_type = <slug>.<type>`; read the type back with `parseEventTypeName` from `@alfred/contracts`. There is no per-source event table: `webhook_events` was dropped in migration 0117 (#975), and a new source must not add a `<source>_events` table. ADR-0097 item 10 adds a derived corpus document for each inbound receipt. Its `source_id` is the receipt id and its `raw` field retains the payload. The table holds two tiers (ADR-0097 item 9, migration 0118). A typed receipt has `raw_kind IS NULL`, its declared dedup key, and a `<slug>.<type>` name the entry declares. A raw receipt is a verified delivery of a kind the entry does not name: `raw_kind` holds the provider's own kind, `event_type` is `<slug>.raw`, `provider_delivery_id` is `raw:<raw_kind>:<payload_hash>`, and the row is `pending` at insert; the same `ingress.deliver` job publishes it as `<slug>.raw` with its kind (#990). Typed consumers read `typedEventReceipts` from `@alfred/db/schemas`. This view filters `raw_kind IS NULL` before any caller LIMIT and omits the discriminator column. The consolidation gate rejects direct table reads outside the view, insert conflict read-back, raw inventory, and the bounded corpus backfill. Migration 0119 adds this view, checks that the raw marker agrees with `raw_kind`, and converts existing raw keys to the kind-and-hash format; its completed-with-timestamp check on raw rows was dropped in migration 0123 (#990). The inventory reader `readRawReceiptInventory` selects raw rows through `integration_credentials`, because an integration slug and an event-source slug are different spaces.

`documents.source` and `observations.source` list only providers with a writer in the tree (#987), but the two columns are enforced in different places. `DOCUMENT_SOURCES` in `@alfred/contracts` is `gmail`, `gmail_attachment`, and the spread of `INBOUND_EVENT_SOURCES` (`github`, `sentry` today), because the corpus receipt writer inserts one document per inbound receipt. The `documents_source_valid` CHECK renders from that list, so a new inbound source needs `db:generate` (migration 0124 trimmed the list). `observations.source` carries NO CHECK: it is bare `text` validated at the write boundary by `observationInsertSchema`, on the same rationale as the rest of the substrate. Its vocabulary comes from `OBSERVATION_REDUCERS`, one record keyed by source that holds each reducer's rank and kinds; `OBSERVATION_SOURCES`, `OBSERVATION_SOURCE_RANK`, `OBSERVATION_KINDS`, and `OBSERVATION_KINDS_BY_SOURCE` are projections of it. A new reducer adds one key there, in the change that lands its first write; a provider is never pre-registered.

Every enum CHECK renders through `inList` in `packages/db/src/helpers.ts`, which SORTS its values. The rendered SQL depends on the set of accepted values, not on the order the constant declares them, so reordering a source constant is not a schema change. Migration 0125 normalized the nine constraints that were still in declaration order; it changed no accepted value.

## Append-only history and attribution (ADR-0107, #1177)

Two tables carry trigger enforcement in migration 0134, because the app runs
on a single database role that legitimately UPDATEs both — GRANT/REVOKE
cannot separate the app from its own writes, so triggers are the enforcement
and they fire for every role including the owner:

- `event_receipts` rejects DELETE and rejects UPDATEs touching any evidence
  or identity column. `processing_status` / `processed_at` / `updated_at`
  stay writable: that lifecycle belongs to the `ingress.deliver` job
  (`markProcessed`), and a literal "no UPDATE" rule would break delivery.
  Corrections are new rows, never mutations.
- `todos` stays mutable on `status` / `sources` / body, but every status
  write sets `resolved_by` (`user` = UI mutator, `agent` = tool call acting
  for the user, `system` = automatic retraction) plus `resolved_reason`.
  Identity columns (`id`, `user_id`, `created_by`, `agent_run_id`) and
  identity-bearing `sources` refs are trigger-immutable; Gmail `thread` refs
  are transport and may come and go under the #355 cap.
- `todo_events` is the append-only transition log, written only by the
  `todos_transition_history` trigger (mint on INSERT, one row per status
  change) and guarded against UPDATE/DELETE by its own trigger.

Bypass needs superuser `session_replication_role` or dropping a trigger —
both outside application reach, by design.

## BullMQ / Redis

`createRedisConnection(kind)` from `@alfred/db/redis` is the only factory. `kind` picks what the connection does when Redis is unreachable, refusing, or accepting but unresponsive. Read the kinds off the `RedisConnectionKind` table in `packages/db/src/redis.ts` — it is the single home of that matrix, and a copy here would drift from it. Pass `{ tracked: false }` for a short-lived probe the caller closes itself; every other connection is drained by `closeRedis()` at shutdown.

Never create raw `new IORedis()` in app code; `pnpm check` fails on one.
