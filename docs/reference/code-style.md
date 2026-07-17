# Code style & review checklist

Distilled from the [review prompt](https://gist.github.com/99Yash/0ab2043d8f6281d82dea4f8d2599ea8a) and the conventions already in this tree. Read it before opening a PR and use it as the checklist when reviewing one. This is the _what to do here_ layer; the _why_ lives in [decisions.md](../../decisions.md) and the deeper mechanics in the sibling reference docs (linked inline).

This doc is the **surface sweep** — a bounded catalog of recurring review rules. For the open-ended directions the checklist cannot cover — looking up for a better structure and drilling down to prove an invariant end-to-end — see [structural-review.md](./structural-review.md).

---

## 1. Never hand-roll a type that already exists

The single highest-frequency defect in this repo: a local shape that mirrors a source of truth and silently drifts from it. If a type can be **derived**, derive it — a copy is a bug waiting for the next schema change.

### Drizzle rows → `$inferSelect` / `$inferInsert`

A table is the source of truth for its row shape, including nullability. Don't restate it.

```ts
// ✗ hand-rolled — drifts the moment a column's nullability changes
interface DocArg {
  id: string;
  title: string | null;
  content: string;
  source: string;
  authoredAt: Date | null;
}

// ✓ derived — title/authoredAt stay nullable because the column is.
// Prefer the NAMED row-type the schema already exports (one per table)…
import type { Document } from "@alfred/db/schemas";
type DocArg = Pick<Document, "id" | "title" | "content" | "source" | "authoredAt">;
```

- **Prefer the named export.** The schema exports named row types such as `Document`, `Entity`, and `UserFact`. `Pick<Document, ...>` is preferred over re-spelling `Pick<typeof documents.$inferSelect, ...>`: identical type, but it uses the canonical name and stays a pure `import type` instead of pulling the table _value_ into scope just to read its inferred shape. Fall back to `typeof table.$inferSelect` only when no named export exists.
- A subset of columns → `Pick<Document, ...>`.
- Everything-but-a-few → `Omit<Document, ...>`.
- A row mapped to a wire/Replicache shape → keep `r: Document` (the named row type) as the **input** and let the output be its own declared type (this is the `rowToFact` / `rowToEntity` / `rowToBriefing` idiom — see `packages/api/src/modules/memory/facts.ts`, `entities.ts`, `briefing/store.ts`).
- Insert payloads → the table's `New*` export where one exists (`NewArtifact`, `NewBriefing`, `NewIntegrationObject`), else `typeof table.$inferInsert` — never a hand-written `{ ... }`. Add a `New<Table>` export when you first need one; don't hand-roll the insert shape.
- A type-only use (only inside `typeof`) takes `import type` so nothing lands in the runtime bundle — required by `verbatimModuleSyntax` (see [typescript.md](./typescript.md)).

### Zod schemas → `z.infer`

If a value is validated by a zod schema, its type is `z.infer<typeof schema>`. Never write a parallel `interface`.

```ts
export const setPreferenceArgsSchema = z.object({
  /* ... */
});
export type SetPreferenceArgs = z.infer<typeof setPreferenceArgsSchema>; // ✓
```

### Drizzle tables → runtime Zod schemas

When a runtime boundary represents the same select/insert/update shape as a
Drizzle table, derive its base validator from the table instead of restating
the columns. This tree uses `drizzle-zod` with the currently pinned Drizzle
version:

```ts
export const preferenceInsertSchema = createInsertSchema(userPreferences, {
  source: memorySourceSchema.optional(),
});

export const setPreferenceArgsSchema = preferenceInsertSchema
  .pick({ userId: true, key: true, value: true, source: true })
  .extend({ key: z.string().min(1).max(200) });
```

- Let Drizzle own column presence, nullability, and database-default semantics.
- Refine scalar business rules at the boundary (`min`, `max`, formats).
- Override `jsonb` fields with their contract-owned Zod schema; `.$type<T>()`
  informs TypeScript but does not validate at runtime.
- Do not generate wire DTOs or Replicache models from a table merely because
  fields overlap. Those schemas intentionally reshape, redact, rename, or
  serialize rows and remain source-of-truth contracts with explicit mappers.
- A generated select schema describes a complete row. For partial query
  projections, derive a matching `.pick(...)` or validate the owning DTO; do
  not parse a partial result with the full-row schema.

### Cross-package shapes → import the canonical one

The same shape declared in `@alfred/contracts`, `@alfred/sync`, `@alfred/api`, and `apps/web` is four chances to disagree. Declare it **once** (contracts/sync are the usual home) and import it. Mind the boundary: `apps/web` cannot import `@alfred/db` (or any server package) — `pnpm check:web-boundaries` enforces this. If web needs a row shape, the canonical type belongs in `@alfred/contracts`, which both sides import.

### When a literal IS correct

Deriving is the default, not a law. A standalone `interface`/`type` is right when the shape is **deliberately not** the source-of-truth shape:

- A wire/DTO reshape — the `Synced*` serializers intentionally pick, rename, and re-type columns for the client. That divergence is the point; don't collapse it back to `$inferSelect`.
- A shape that merely happens to overlap a table today but models a different concept and should evolve independently.

If you keep a literal, a one-line comment saying _why it isn't derived_ saves the next reviewer the investigation.

### Before you derive: confirm the type is identical

A derive is only correct when the derived type _equals_ what you'd hand-write. The trap is that a column rarely infers to the obvious type, so a `Pick<>` that reads right silently widens or re-nullable-s a field. Only `.notNull()` controls select-nullability — `.default()` / `.defaultNow()` do **not**.

| Column                            | `$inferSelect` gives           |
| --------------------------------- | ------------------------------ |
| `text().notNull()`                | `string`                       |
| `text()`                          | `string \| null`               |
| `text().$type<Foo>().notNull()`   | `Foo` (narrower than `string`) |
| `jsonb()` (no `.$type<>()`)       | `unknown` — **not** your shape |
| `numeric()` (no `mode: "number"`) | `string` — **not** `number`    |
| `timestamp()`                     | `Date \| null`                 |

The five ways a "safe" derive silently changes the type (all real cases from the June audit):

- **Untyped `jsonb` is `unknown`.** `documents.metadata` is `jsonb().notNull()` with no `.$type<>()` → `unknown`. So even on §1's poster-child table you can `Pick` `id/title/content/authoredAt` but **not** `metadata: Record<string, unknown>`. Any row whose `rowToX` mapper `.parse()`s a jsonb column (`rowToEntity`, `rowToProfile`, `rowToChunk`, `rowToPref`) has narrowed that field on purpose — the mapped output _is_ the contract; keep it literal.
- **`numeric` is `string`.** `modelPrices`' money columns infer `string`; `fetchPrice` does `Number(...)`. A `number`-typed lookup is a transform, not a mirror.
- **`.$type<Brand>()` is narrower than the literal.** A hand-rolled `toolName: string` is _wider_ than the column's `.$type<ToolName>()`. Deriving narrows it — often an upgrade, but a real change: confirm every assignment site still fits.
- **Nullability narrowed behind a guard.** `selectDueRows` does `if (!row.nextRunAt) continue`, so `DueRow.nextRunAt` is `Date`, not the column's `Date | null`. Deriving re-adds `| null` and breaks the downstream non-null guarantee (same for `RecentRejection.decidedAt`).
- **An interface-first schema is canonical — don't invert it.** When a schema is annotated against a hand-written interface — `z.object({ … }) satisfies z.ZodType<Foo>` or `const fooSchema: z.ZodType<Foo> = …` (the `briefing.ts` / `triage.ts` contribution types) — the `interface Foo` is the source and the annotation is its drift guard. `type Foo = z.infer<typeof fooSchema>` then makes `Foo` derive from a schema that references `Foo`: a circular reference (TS2456). Only `z.infer` from a _plain_ schema with no such back-reference.

After a derive lands, drop now-orphaned imports — the literal often named a union (e.g. `ActionStagingStatus`) the derived form no longer references, and `noUnusedLocals` fails the build otherwise.

---

## 2. TypeScript discipline

- **No `any`.** Reach for `unknown` + a narrowing guard. Use the shared guards in `@alfred/contracts` (`isRecord`, `getPath`, `toRecord`, `isNonEmptyString`) instead of `as Record<string, unknown>` casts.
- **Type guards over casts.** `as` asserts; it doesn't check. A guard that the compiler verifies beats a cast that lies.
- **Exhaustive switches** end with a `default` that assigns to `const _exhaustive: never = x` — adding a union member then fails the build instead of silently falling through.
- **Minimize `!`.** A non-null assertion is a runtime promise the compiler can't keep. Narrow instead.
- **`process.env` is banned** — go through `serverEnv()` from `@alfred/env/server`.

### Constants and configuration ownership

Name non-obvious constants. Inline literals are fine for transparent arithmetic (`+ 1`, `* 1000`) and one-off formatting, but thresholds, caps, TTLs, retry counts, batch sizes, prompt budgets, and model/tool payload limits need a named constant with a short reason when the value is not self-evident.

Put the constant at the narrowest stable owner:

- **`@alfred/contracts`** only for cross-boundary semantics: API/schema limits, synced/wire enums, client-visible tool caps, output truncation guarantees, and values that both server and web/model contracts must agree on.
- **Owning package/module** for implementation mechanics: provider HTTP timeouts, Redis TTLs, queue batch sizes, retry windows, cache keys, local prompt budgets, and private heuristics. If several files in the same domain need it, create a small local `constants.ts` / `config.ts` in that package instead of exporting it from contracts.
- **Environment** only for deploy-time operator knobs, secrets, endpoints, or values that should differ by environment. Do not use env vars just to avoid naming a constant.

Before moving a value into `@alfred/contracts`, confirm the web bundle is allowed to import every dependency it pulls in. Contracts must stay runtime-light and server-agnostic.

## 3. Backend (api / db / integrations)

- **No N+1.** Use Drizzle relational queries (`with:`) or a join; don't loop queries. Paginate every list endpoint.
- **Transactions** wrap any multi-step write that must be atomic.
- **Timeouts on every external/LLM call** — APIs ~30s, streaming ~60s. Pass `abortSignal`; cancel siblings on failure so a `Promise.all` loser doesn't keep burning a billable LLM call. (AI SDK specifics — option names, structured output — in [ai-sdk.md](./ai-sdk.md).)
- **Idempotency** on anything retried by BullMQ or a webhook. Derive a stable key (the extraction sub-agent keys on `(runId, stepId, doc.id)`).
- **Never log a full error object** — it can carry connection strings, tokens, PII. Log a message + safe fields. Mask PII.
- **Webhook signatures** verified with a timing-safe compare, against the **raw** body (re-parsed JSON breaks HMAC).
- **Migrations:** `db:generate` → `db:migrate`. Never `db:push` outside local exploration (see [database.md](./database.md)). New endpoints inherit auth + rate-limiting via `.guard()` / `.onError()` — don't leave a route uncovered (see [elysia.md](./elysia.md)).

## 4. Frontend (apps/web)

- **Effects:** clean up subscriptions/timers; verify dependency arrays (missing dep = stale closure, extra dep = loop). Guard against state updates after unmount.
- **Render every state** — loading, error, empty, populated. An async surface with no empty/error branch is unfinished.
- **SSR-safe:** guard `window`/`document`/browser-only APIs. Sanitize any HTML you inject.
- **No stray `console.log`**; surface errors to the user, don't swallow them.
- **Keys** are stable IDs, never array index.
- **Accessibility:** keyboard-reachable interactive elements, ARIA where needed, never color as the only signal. Prefer CSS-variable shorthands over arbitrary values.

---

## Recurrent high-signal patterns (the review hit-list)

1. A local shape duplicating a Drizzle table or zod schema → derive it (§1).
2. Full error object logged → leaks secrets/PII.
3. External/LLM call with no timeout or `abortSignal`.
4. New endpoint missing rate-limit / auth coverage.
5. Silent `catch` with no user feedback.
6. Duplicated logic that represents one co-changing domain truth → centralize it; leave coincidental similarity separate.
7. Non-exhaustive switch over a union → add the `never` check.
8. `useEffect` updating state after unmount / wrong deps.
9. Webhook HMAC verified against re-parsed (not raw) body.
10. Unbilled `Promise.all` work that keeps running after a sibling fails.

> Before claiming a library _can't_ do something, check its `.d.ts`, its repo, or the relevant reference doc here. Most "limitations" are a missing option name.
