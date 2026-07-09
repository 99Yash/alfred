# Alfred DB Guidance

`@alfred/db` is the **source of truth for row shapes**. 59 tables, 62 named `$inferSelect` exports (`Entity`, `Todo`, `UserFact`, `ChatAttachment`, …), all re-exported from `@alfred/db/schemas`. Consumers derive from these — see [`docs/reference/code-style.md` §1](../../docs/reference/code-style.md): _never hand-roll a type that already exists._

## Row Types

- Every table has a named SELECT export (`export type Entity = typeof entities.$inferSelect`). Consumers should import the **named type** and `Pick`/`Omit` it — never restate the columns.
- Prefer `Pick<Entity, "id" | "kind">` over `Pick<typeof entities.$inferSelect, …>`: identical type, canonical name, and a type-only consumer can `import type { Entity }` without pulling the table _value_ into scope.
- INSERT types are the gap: only a few `New*` exports exist (`NewArtifact`, `NewBriefing`, `NewChatAttachment`, `NewIntegrationObject`). Add `New*` (`typeof x.$inferInsert`) **on demand** when a consumer needs it — that's better than the consumer re-spelling `typeof x.$inferInsert` inline. Don't add all 59 speculatively.

## Enums Live in TS, Not the DB

- There are **zero `pgEnum`s**. Every `status`/`kind`/`channel`/`audience` column is `text`. So enums are TS-only, and the canonical home for a cross-boundary one is `@alfred/contracts` (web-safe; `@alfred/db` isn't importable from `apps/web`).
- When you add a status/kind column, single-source its literal union from `@alfred/contracts` (or re-export from there); don't leave the allowed set implicit in a bare `text` column.

## jsonb Columns

- A plain `jsonb` column infers to `unknown`; a `jsonb().$type<T>()` infers to `T`. Mapper functions (`rowToEntity`, `rowToChunk`, …) that restate an untyped jsonb column are **correct, not duplication** — there's no narrower row type to derive from.

## Migrations (non-negotiable)

- Schema change flow is always `db:generate` → `db:migrate`. **Never `db:push` outside local exploration** — it desyncs the drizzle ledger from prod (see the local-DB-ledger-drift note in the repo).
