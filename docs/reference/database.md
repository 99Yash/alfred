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

`event_receipts` is the one delivery record for every inbound event source (ADR-0090, ADR-0097). An inbound webhook row stores the verified body in `payload` under `provider = <source slug>` and `event_type = <slug>.<type>`, and a completed, corpus-projected receipt keeps it only until the retention window releases it to NULL (`packages/assistant/src/connections/ingestion/receipt-payload-reaper.ts`, 90 days), so a NULL `payload` on an inbound source does not mean Gmail. Read the type back with `parseEventTypeName` from `@alfred/contracts`. There is no per-source event table: `webhook_events` was dropped in migration 0117 (#975), and a new source must not add a `<source>_events` table. ADR-0097 item 10 adds a derived corpus document for each inbound receipt. Its `source_id` is the receipt id and its `raw` field retains the payload. The table holds two tiers (ADR-0097 item 9, migration 0118). A typed receipt has `raw_kind IS NULL`, its declared dedup key, and a `<slug>.<type>` name the entry declares. A raw receipt is a verified delivery of a kind the entry does not name: `raw_kind` holds the provider's own kind, `event_type` is `<slug>.raw`, `provider_delivery_id` is `raw:<raw_kind>:<payload_hash>`, and the row is `pending` at insert; the same `ingress.deliver` job publishes it as `<slug>.raw` with its kind (#990). Typed consumers read `typedEventReceipts` from `@alfred/db/schemas`. This view filters `raw_kind IS NULL` before any caller LIMIT and omits the discriminator column. The consolidation gate rejects direct table reads outside the view, insert conflict read-back, the deliver job, raw inventory, the bounded corpus backfill, and payload retention. Migration 0119 adds this view, checks that the raw marker agrees with `raw_kind`, and converts existing raw keys to the kind-and-hash format; its completed-with-timestamp check on raw rows was dropped in migration 0123 (#990). The inventory reader `readRawReceiptInventory` selects raw rows through `integration_credentials`, because an integration slug and an event-source slug are different spaces.

`documents.source` and `observations.source` list only providers with a writer in the tree (#987), but the two columns are enforced in different places. `DOCUMENT_SOURCES` in `@alfred/contracts` is `gmail`, `gmail_attachment`, and the spread of `INBOUND_EVENT_SOURCES` (`github`, `sentry` today), because the corpus receipt writer inserts one document per inbound receipt. The `documents_source_valid` CHECK renders from that list, so a new inbound source needs `db:generate` (migration 0124 trimmed the list). `observations.source` carries NO CHECK: it is bare `text` validated at the write boundary by `observationInsertSchema`, on the same rationale as the rest of the substrate. Its vocabulary comes from `OBSERVATION_REDUCERS`, one record keyed by source that holds each reducer's rank and kinds; `OBSERVATION_SOURCES`, `OBSERVATION_SOURCE_RANK`, `OBSERVATION_KINDS`, and `OBSERVATION_KINDS_BY_SOURCE` are projections of it. A new reducer adds one key there, in the change that lands its first write; a provider is never pre-registered.

`entity_identities` pairs a `kind` with the `source` that wrote it, and the same record owns that pair (#1028). Each reducer entry lists the `identityKinds` its projection mints (`gmail`: `email`; the others none), and a kind may register under more than one source. `EntityIdentityKind` is the union of those lists and types the `kind` column, so a raw insert of an unregistered kind fails the type check. `recordEntityIdentity` parses the pair with `entityIdentitySourceKindSchema` before the insert. There is no CHECK, on the same rationale as `observations.source`. `IDENTITY_KINDS` is the registered kinds plus `FORWARD_IDENTITY_KINDS`: kinds an `IdentityRef` may name but no source may write yet (`domain`, `github_login`, `google_directory_id`, `integration_object_key`, and the rest). `domain` is forward even though `gmail-edge-fold` mints `domain` nodes: a node anchor on `entity_nodes.canonical_identity` is not an identity row. A reducer that starts to write a forward kind moves it from the forward list to its own `identityKinds`; the type check fails while the kind is in both. The pair is enforced only in `recordEntityIdentity`: `kind` and `source` are typed independently, so a raw `.insert(entityIdentities)` of a registered kind under a source that does not mint it (for example `{ kind: "email", source: "user" }`) compiles. Only tests insert raw rows.

Every enum CHECK renders through `inList` in `packages/db/src/helpers.ts`, which SORTS its values. The rendered SQL depends on the set of accepted values, not on the order the constant declares them, so reordering a source constant is not a schema change. Migration 0125 normalized the nine constraints that were still in declaration order; it changed no accepted value.

## Derive row types from the table

A table is the source of its row shape, nullability included. Do not restate it.

```ts
// ✗ hand-rolled — drifts when a column changes nullability
interface DocArg {
  id: string;
  title: string | null;
  authoredAt: Date | null;
}

// ✓ derived — title and authoredAt stay nullable because the columns are
import type { Document } from "@alfred/db/schemas";
type DocArg = Pick<Document, "id" | "title" | "authoredAt">;
```

- Use the named row type that the schema exports (`Document`, `Entity`, `UserFact`). It is the same type as `typeof documents.$inferSelect`, and it stays a pure `import type`. Use `typeof table.$inferSelect` only when no named export exists.
- Use `Pick<Document, ...>` for a subset and `Omit<Document, ...>` for all columns except a few.
- A mapper from a row to a wire shape takes the named row type as input and declares its own output type. `rowToFact` in `packages/assistant/src/knowledge/facts.ts` and `rowToBriefing` in `packages/assistant/src/briefings/store.ts` are the model.
- An insert payload uses the `New*` export of the table (`NewArtifact`, `NewBriefing`, `NewIntegrationObject`), else `typeof table.$inferInsert`. Add a `New<Table>` export when you first need one.

### Confirm that the derived type is identical

A column often infers to a type that you do not expect. Only `.notNull()` controls the nullability of a select. `.default()` and `.defaultNow()` do not.

| Column | `$inferSelect` gives |
| --- | --- |
| `text().notNull()` | `string` |
| `text()` | `string \| null` |
| `text().$type<Foo>().notNull()` | `Foo` (narrower than `string`) |
| `jsonb()` with no `.$type<>()` | `unknown`, not your shape |
| `numeric()` with no `mode: "number"` | `string`, not `number` |
| `timestamp()` | `Date \| null` |

Five ways a derive changes a type with no error:

- **Untyped `jsonb` is `unknown`.** `documents.metadata` has no `.$type<>()`, so you cannot `Pick` it as `Record<string, unknown>`. A mapper that `.parse()`s a jsonb column narrows that field on purpose. Its output is the contract, so keep it literal.
- **`numeric` is `string`.** The money columns of `modelPrices` infer `string`, and `fetchPrice` in `packages/ai/src/metering/prices.ts` converts them. A lookup typed `number` is a transform, not a mirror.
- **`.$type<Brand>()` is narrower than the literal.** A hand-written `toolName: string` is wider than `.$type<ToolName>()`. A derive narrows it, so confirm that each assignment site still fits.
- **A guard narrowed the nullability.** `selectDueRows` in `packages/assistant/src/automation/tick.ts` skips a row with no `nextRunAt`, so `DueRow.nextRunAt` is `Date`. A derive adds `| null` again and breaks the guarantee downstream.
- **An interface-first schema is the source.** When a schema is annotated against a hand-written interface (`z.object({ … }) satisfies z.ZodType<Foo>`), the interface is the source and the annotation is its drift guard. `type Foo = z.infer<typeof fooSchema>` then makes a circular reference (TS2456). Use `z.infer` only on a plain schema.

## Append-only history and attribution (ADR-0107, #1177)

Two tables carry trigger enforcement in migration 0134, because the app runs
on a single database role that legitimately UPDATEs both — GRANT/REVOKE
cannot separate the app from its own writes, so triggers are the enforcement
and they fire for every role including the owner:

- `event_receipts` rejects direct DELETE (FK-cascade from a user/credential
  wipe is allowed) and rejects UPDATEs touching any evidence
  or identity column — except that `payload` may be released to NULL
  (migration 0139). `processing_status` / `processed_at` / `updated_at`
  stay writable: that lifecycle belongs to the `ingress.deliver` job
  (`markProcessed`), and a literal "no UPDATE" rule would break delivery.
  Corrections are new rows, never mutations.
- `todos` stays mutable on `status` / `sources` / body, but every insert and
  every change of `status`, `name`, or `due_date` sets `todos.attribution`, the
  ADR-0115 record (`TodoAttribution` in `@alfred/contracts`: actor, authority,
  authority ref, run and tool call ids for an agent, `cause`, optional `note`).
  The trigger rejects a write without a record, and it clears the column after
  each update, so a record never carries over to the next write.
  Identity columns (`id`, `user_id`, `created_by`, `agent_run_id`) and
  identity-bearing `sources` refs are trigger-immutable; Gmail `thread` refs
  are transport and may come and go under the #355 cap.
- `todo_events` is the append-only change log, written only by the
  `todos_creation_history` (AFTER INSERT) and `todos_change_history` (BEFORE
  UPDATE, one row per write that changes status, name, or due date) triggers.
  Each row copies the attribution record and the before/after values. It is guarded against UPDATE/direct-DELETE by its own trigger
  (FK-cascade from a user/todo wipe is allowed).

Bypass needs superuser `session_replication_role` or dropping a trigger —
both outside application reach, by design. FK-cascade from a user/todo or
user/credential wipe is the one allowed DELETE path, so owner deletion and
test cleanup keep working.

## BullMQ / Redis

`createRedisConnection(kind)` from `@alfred/db/redis` is the only factory. `kind` picks what the connection does when Redis is unreachable, refusing, or accepting but unresponsive. Read the kinds off the `RedisConnectionKind` table in `packages/db/src/redis.ts` — it is the single home of that matrix, and a copy here would drift from it. Pass `{ tracked: false }` for a short-lived probe the caller closes itself; every other connection is drained by `closeRedis()` at shutdown.

Never create raw `new IORedis()` in app code; `pnpm check` fails on one.
