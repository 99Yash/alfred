# Alfred DB Guidance

`@alfred/db` owns the database schema, migrations, connections, and database-level helpers. See [database conventions](../../docs/reference/database.md).

## Row Types

- Export a named `$inferSelect` type for each table and consume it with `Pick`/`Omit` rather than restating columns or importing a table value for type-only use.
- Export a named `$inferInsert` type when a consumer needs one; do not hand-roll insert shapes or add speculative exports.
- A mapper may intentionally narrow an untyped `jsonb` value. Its output contract is not a duplicate of the row type.

## Shared Semantics

- Keep browser-visible status/kind literals and other cross-boundary semantics in `@alfred/contracts`; the web app cannot import database schemas.
- Use `.$type<T>()` for `jsonb` only when the database layer can truthfully guarantee that shape. Otherwise retain `unknown` and validate at the owning mapper boundary. A `$type` lets a reader use the column fields with no parse. So a column that a raw SQL merge (`jsonb_set`, `||`) writes, or that holds old rows of a different shape, keeps no `$type`. Check its Drizzle insert literals with `satisfies <Input>` instead, as `ingestion_state.state` does (see [schemas](../../docs/reference/schemas.md)). No gate checks this rule, because only the writers and the stored rows show if a `$type` is true.
- Treat the result of raw `db().execute(...)` calls as `unknown`; read rows with `rowsFromExecute(result, schema)` and a zod schema next to the query, never a cast. Raw rows skip Drizzle's column mappers, so timestamps and `numeric`/`bigint` values arrive as text. Use `createExecuteRowSchema(table)` for whole-table rows.

## Redis Connections

- `createRedisConnection(kind)` in `packages/db/src/redis.ts` is the only door to an ioredis client, and its `RedisConnectionKind` table is the single home of what a connection does when Redis is unreachable. Pick the kind there; do not restate its options at a call site.

## Migrations

- Change schemas with `db:generate` then `db:migrate`. Never use `db:push` outside local exploration.
- Review generated SQL and preserve the migration ledger; do not edit production state by bypassing migrations.
