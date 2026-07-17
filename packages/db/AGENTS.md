# Alfred DB Guidance

`@alfred/db` owns the database schema, migrations, connections, and database-level helpers. See [database conventions](../../docs/reference/database.md).

## Row Types

- Export a named `$inferSelect` type for each table and consume it with `Pick`/`Omit` rather than restating columns or importing a table value for type-only use.
- Export a named `$inferInsert` type when a consumer needs one; do not hand-roll insert shapes or add speculative exports.
- A mapper may intentionally narrow an untyped `jsonb` value. Its output contract is not a duplicate of the row type.

## Shared Semantics

- Keep browser-visible status/kind literals and other cross-boundary semantics in `@alfred/contracts`; the web app cannot import database schemas.
- Use `.$type<T>()` for `jsonb` only when the database layer can truthfully guarantee that shape. Otherwise retain `unknown` and validate at the owning mapper boundary.

## Migrations

- Change schemas with `db:generate` then `db:migrate`. Never use `db:push` outside local exploration.
- Review generated SQL and preserve the migration ledger; do not edit production state by bypassing migrations.
