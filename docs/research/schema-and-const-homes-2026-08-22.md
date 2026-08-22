# Where Zod schemas and constants live

Research date: 2026-08-22

## The question

Two conventions are on the table:

1. **Zod schema homes.** Current rule: ownership by package role. Browser-safe cross-boundary schemas live in [`packages/contracts/src/*`](../../packages/contracts/src/tool-schemas.ts). Database insert schemas derive from Drizzle rows via `createInsertSchema` ([`packages/db/src/schema/memory.ts`](../../packages/db/src/schema/memory.ts)). The rejected alternative was "a `schemas/` directory per package."
2. **Constant homes.** Current rule: cross-seam values in `@alfred/contracts` const tables (`as const`, sometimes `satisfies`), owner-private constants beside their logic. One coupling-driven model file exists ([`packages/env/src/pool.ts`](../../packages/env/src/pool.ts)). Under discussion: one named const-table file per package, named like the existing `briefing-constants.ts` / `tool-constants.ts`.

This note separates what primary sources say, what prominent repositories factually do, and inference.

## Part A — What the primary sources say

### Zod provides derivation primitives but no placement guidance

Zod infers static types from schemas. `z.infer` extracts the output type; `z.input` and `z.output` handle schemas where transforms make input and output diverge. [Zod basic usage](https://zod.dev/basics#inferring-types)

For checking a schema against a type that already exists, current Zod docs present `z.toZod<T>()`, which checks *exact* type equality — an extra key, an omitted key, or `z.any()` is a compile error. They contrast it with `satisfies z.ZodType<Player>`, which checks assignability only: extra keys and bare `z.any()` slip through. [Zod basic usage](https://zod.dev/basics#matching-an-existing-type)

Object schemas support structural derivation, deliberately mirroring TypeScript's own utility types:

- `.extend()` adds or overwrites fields. The docs recommend spread syntax (`z.object({ ...Dog.shape, breed: z.string() })`) as an alternative, noting it is more `tsc`-efficient because chained `.extend()` calls get quadratically expensive on large schemas. [Zod `.extend()`](https://zod.dev/api#extend)
- `.pick()` / `.omit()` are "inspired by TypeScript's built-in `Pick` and `Omit` utility types". [Zod `.pick()`](https://zod.dev/api#pick), [Zod `.omit()`](https://zod.dev/api#omit)
- `.partial()` makes some or all properties optional, "inspired by" `Partial`. [Zod `.partial()`](https://zod.dev/api#partial)
- Recursive schemas work via getters, and all object APIs compose on them. [Zod recursive objects](https://zod.dev/api#recursive-objects)

The design intent is clear: one base schema, many derived projections. What the docs do **not** contain is any statement about where schemas should live — no directory layout, no per-package organization advice. I checked the full schema API source (`packages/docs/content/api.mdx`, [colinhacks/zod](https://github.com/colinhacks/zod/blob/main/packages/docs/content/api.mdx)) and the basic-usage page; neither addresses file placement. Zod is neutral on this question.

### drizzle-zod makes derivation the documented path

Drizzle's official zod integration derives validation schemas from table definitions rather than asking for re-declaration:

- `createSelectSchema(users)` builds the shape of queried data and catches projection mismatches: parsing a row selected with `{ id, name }` errors because the schema demands `age`. [drizzle-zod select schema](https://orm.drizzle.team/docs/zod#select-schema)
- `createInsertSchema(users)` builds the insert shape — identity columns omitted, defaults respected. Documented use case: validating API requests before `db.insert(...).values(parsed)`. [drizzle-zod insert schema](https://orm.drizzle.team/docs/zod#insert-schema)
- `createUpdateSchema(users)` builds the all-fields-optional update shape. [drizzle-zod update schema](https://orm.drizzle.team/docs/zod#update-schema)
- Refinements accept either a callback to *extend* a derived field schema (`name: (schema) => schema.max(20)`) or a full Zod schema to *overwrite* it. This is how provider-specific constraints layer onto the table-derived baseline. [drizzle-zod refinements](https://orm.drizzle.team/docs/zod#refinements)
- `createSchemaFactory` supports extended Zod instances and coercion options. [drizzle-zod factory functions](https://orm.drizzle.team/docs/zod#factory-functions)

A data-type reference maps every column type to its Zod equivalent automatically (e.g. `pg.varchar({ length })` → `z.string().max(length)`), so constraints declared once on the table flow into every derived schema. [drizzle-zod data type reference](https://orm.drizzle.team/docs/zod#data-type-reference)

Alfred already follows this: `userFactInsertSchema = createInsertSchema(userFacts, {...})` in [`packages/db/src/schema/memory.ts:114`](../../packages/db/src/schema/memory.ts).

### `as const`: literal preservation, shallow immutability

TypeScript 3.4's const assertion signals that no literal type widens, object literals get `readonly` properties, and array literals become readonly tuples. The docs show it enabling enum-like patterns without the `enum` construct:

```ts
export const Colors = { red: "RED", blue: "BLUE", green: "GREEN" } as const;
```

Two caveats matter for a const-table convention. First, immutability is shallow: a nested array referenced from a `const`-asserted object stays mutable (`foo.contents.push(5)` still works). Second, assertions apply only to literal expressions. [TypeScript 3.4, const assertions](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-4.html#const-assertions)

So `as const` gives a const table its two useful properties — exhaustive literal keys and literal-typed values — but does nothing to enforce that a dependent record covers all keys.

### `satisfies`: constraint without widening

TypeScript 4.9's `satisfies` validates that an expression matches a type while preserving the expression's most specific inferred type. The release notes demonstrate exactly the const-table idiom Alfred uses: `satisfies Record<Colors, unknown>` catches both a missing key ("ensure we have *all* the keys") and an extra key ("but no more"), while indexed reads keep their narrow value types instead of widening to the record's value union. [TypeScript 4.9, the satisfies operator](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html#the-satisfies-operator)

Together, `as const` + `satisfies Record<KeyUnion, Value>` gives: exhaustiveness checking, typo detection, literal-typed reads, and readonly properties. That combination is why the pattern works mechanically regardless of which file hosts the table.

### t3-env: the default lives in the schema, consumers read the result

t3-env's core pattern is `createEnv({ server: { DATABASE_URL: z.url(), ... }, runtimeEnv: process.env })`. Defaults are expressed with the validator's own `.default()`, and application code imports the single parsed `env` object — there is no second place where a fallback constant can drift from the schema. The docs' discussion of defaults is about empty-string handling (`emptyStringAsUndefined`) precisely so that "a string with a default value" applies correctly. [T3 Env core docs](https://env.t3.gg/docs/core)

The one placement opinion t3-env documents is audience-driven, not package-driven: defining client and server schemas in one file means server variable names ship to the client bundle, so split into `env/server.ts` and `env/client.ts` when names are sensitive. [T3 Env core docs](https://env.t3.gg/docs/core) There is no "defaults table per package" pattern anywhere in the library.

This matches what Alfred already built in [`packages/env/src/pool.ts`](../../packages/env/src/pool.ts): `agentWorkerConcurrencySchema` carries `.default(AGENT_WORKER_CONCURRENCY_DEFAULT)`, and `derivePoolMax` computes dependents from the one knob instead of restating fallbacks.

## Part B — What prominent monorepos factually do

I verified each repository's full file tree via the GitHub git-trees REST API (`main` branch, `"truncated": false` in all three responses), then filtered for `constants` and `schemas` paths. These are factual observations, not endorsements.

### trpc/trpc

2,041 paths. Zero files matching `constants` anywhere under `packages/`, and zero `schemas/` directories — the only `schemas.ts` in the tree sits in `examples/next-formdata/src/utils/schemas.ts`. Packages organize by feature with colocated modules, e.g. `packages/react-query/src/shared/hooks/createHooksInternal.tsx`. tRPC simply has neither convention.

### calcom/cal.com

10,280 paths. No uniform convention. Constants sit beside their features wherever the feature lives: `apps/web/modules/bookings/lib/constants.ts`, `apps/api/v2/src/platform/event-types/event-types_2024_06_14/constants/constants.ts`, `packages/app-store-cli/src/constants.ts`. Schemas also sit beside features: `packages/features/eventtypes/lib/schemas.ts`, plus generated files such as `packages/app-store/apps.schemas.generated.ts`. No package has a dedicated top-level `schemas/` directory; the closest is an app-local `apps/web/components/schemas/`.

### bluesky-social/atproto

3,829 paths. Owner-private `constants.ts` files sit beside the code they serve: `packages/oauth/oauth-client/src/constants.ts`, `packages/oauth/oauth-provider/src/oauth-constants.ts`, `packages/internal/identity-resolver/src/constants.ts`, among others. Zero `schemas/` directories. The schema story is different by design: the source of truth is the JSON lexicon files under `lexicons/` (e.g. `lexicons/app/bsky/actor/defs.json`), and TypeScript types are generated from them — derivation enforced by tooling, not convention.

### Summary of observations

| Repo | Per-package `constants` table file | Per-package `schemas/` dir | Actual pattern |
| --- | --- | --- | --- |
| trpc/trpc | none | none | feature colocation |
| calcom/cal.com | scattered, beside features | none | feature colocation + codegen |
| bluesky-social/atproto | several, beside owners | none | JSON source of truth + codegen |

None of the three uses either convention currently under discussion. All three lean toward ownership-by-role and colocation, and two of three rely on generation or derivation over hand-maintained parallel declarations.

## Part C — Inference and opinion

*(This section is inference grounded in the above, not something the sources state.)*

1. **Derive-don't-redeclare has full ecosystem backing.** Every relevant tool is built around it: drizzle-zod exists precisely so schemas are never re-declared from tables; Zod's `.extend`/`.pick`/`.omit`/`.partial` exist precisely so variants come from one base; atproto generates types from lexicons for the same reason. A hand-copied schema like the Google token-row shape in [`apps/web/src/lib/integrations/use-integration-status.ts:22`](../../../apps/web/src/lib/integrations/use-integration-status.ts) has no tooling protecting it from drift — though note that file documents itself as a deliberate UI projection with a normalization transform, which is the legitimate case for a local schema.
2. **The friction point is boundary choice, not syntax.** When a web projection intentionally differs from the stored row (nulling `installationId`, keeping only consumed fields), re-deriving from the DB row type would be wrong anyway — the row type lives in `@alfred/db`, which browser code cannot import. The real fix for that class of drift is an owning browser-safe schema at the API boundary (contracts, or the route module exporting its row schema), with the web projection derived from *that* via `.pick()` or shape-spread — not derivation straight from Drizzle.
3. **"One const-table file per package" is an invention without external precedent**, but so was the current contracts-only rule. Nothing in TypeScript cares where a const table lives; `as const` + `satisfies` provides identical guarantees in any file. The evidence that bears on the question is organizational: all three surveyed repos keep constants beside their owners or scatter them by feature, and none centralizes per package.
4. **Alfred's existing const files are domain-scoped within one package, not per-package tables.** `briefing-constants.ts` and `tool-constants.ts` both live in `@alfred/contracts` and are split by domain because browser and server must agree on those specific values. Extending that naming to other packages would change the rule from "cross-boundary values go here" to "this package keeps its constants in one file," which is a different — and weaker — invariant. The `pool.ts` model shows when a dedicated constants file earns its existence: when several derived values couple to one knob, so the file encodes a relationship, not just proximity.

## Implications for alfred

Grounded strictly in the findings above:

1. **Adopt derive-don't-redeclare as written policy.** It matches drizzle-zod's design, Zod's derivation primitives, and t3-env's single-parsed-object pattern. DB insert/select/update schemas come from `createInsertSchema`/`createSelectSchema`/`createUpdateSchema` with refinements; variants of an owning schema come from `.pick()`/`.omit()`/shape-spread; `z.toZod<T>()` (or `satisfies z.ZodType<T>` where exactness is not needed) can pin a projection to its target type.
2. **Fix schema drift at the owning boundary, not by copying.** For cross-seam shapes like credential rows, export the parsed schema or row type from a browser-safe home (`@alfred/contracts` or the route's public surface) so the web projection can derive from it. A locally re-declared shape is acceptable only as a documented, narrower projection.
3. **Do not adopt "one const-table file per package" on the evidence available.** No surveyed repo does it, and Alfred's working rule (cross-seam values in contracts const tables, owner-private constants beside logic, coupled-value models like `pool.ts`) already covers the cases the sources speak to. If a package later accumulates genuinely coupled constants, follow the `pool.ts` model — name the relationship, not the category.
4. **Keep `as const` + `satisfies` for every shared const table.** That pair is what supplies exhaustiveness and literal typing; it works identically wherever the table lives, so placement decisions can stay purely organizational.

## Sources

- [Zod basic usage — inferring types](https://zod.dev/basics#inferring-types)
- [Zod basic usage — matching an existing type](https://zod.dev/basics#matching-an-existing-type)
- [Zod schema API](https://zod.dev/api) (source checked: [`packages/docs/content/api.mdx`](https://github.com/colinhacks/zod/blob/main/packages/docs/content/api.mdx) — sections [`.extend()`](https://zod.dev/api#extend), [`.pick()`](https://zod.dev/api#pick), [`.omit()`](https://zod.dev/api#omit), [`.partial()`](https://zod.dev/api#partial), [recursive objects](https://zod.dev/api#recursive-objects))
- [drizzle-zod documentation](https://orm.drizzle.team/docs/zod)
- [TypeScript 3.4 — const assertions](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-4.html#const-assertions)
- [TypeScript 4.9 — the satisfies operator](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html#the-satisfies-operator)
- [T3 Env core docs](https://env.t3.gg/docs/core)
- Repository trees verified 2026-08-22 via GitHub git-trees API: [trpc/trpc](https://github.com/trpc/trpc), [calcom/cal.com](https://github.com/calcom/cal.com), [bluesky-social/atproto](https://github.com/bluesky-social/atproto)
