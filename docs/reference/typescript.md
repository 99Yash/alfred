# TypeScript conventions

- TypeScript is pinned through the workspace catalog and every workspace declaration must use `"typescript": "catalog:"`. Keeping one compiler version avoids duplicate peer-instantiated library types.
- All packages use `"moduleResolution": "bundler"` and `"verbatimModuleSyntax": true`. Use `import type` for type-only imports.
- `exactOptionalPropertyTypes` is on for every workspace's **`src`** (#552): `k?: T` accepts *absent or `T`*, never a present `undefined`. See [code style](./code-style.md) for which spelling to declare and how to satisfy third-party types that cannot be widened.
- The flag is set in `tsconfig.base.json`, so it applies to anything a `tsconfig` compiles — but the 201 authored files under `packages/*/test` and `apps/web/test` sit outside every `include` (which is `["src"]`) and run under `tsx --test`, which strips types without checking them. Test code is therefore **unchecked** today, by that flag and by every other. It was swept once by hand for #552 and is clean of flag-caused errors; nothing keeps it that way. Wiring it into `check-types` is tracked separately — note `packages/api/tsconfig.json` is `composite: true` with `rootDir: "src"`, so `test` cannot simply be appended to `include`.
- `apps/web` uses `tsc --noEmit` for type-checking (not `tsc -b`) — it's a leaf node, not a composite project.
- All other packages use `tsc -b` via composite project references.
- Workspace packages export TS source directly (`./src/index.ts`), so `pnpm check-types` works on a fresh tree without a prior build.
- Private workspace packages build declarations directly with native `tsc -b --emitDeclarationOnly --force`; they do not bundle their source. `tsdown` is reserved for the production server, where it bundles workspace source and committed operational scripts into plain Node.js output.
- When reading unfamiliar library APIs, inspect type definitions in `node_modules/.pnpm/*/node_modules/<pkg>/dist/*.d.ts` — do not guess from old docs or training data.

## The `scripts/` program

`scripts/` is not a workspace, so no package's `check-types` reaches it. It has its own standalone program, `scripts/tsconfig.json`, and the root `check-types` script runs it directly (`turbo run check-types && tsc -p scripts/tsconfig.json`). Turbo cannot own that task: the tree is not a workspace, and a root `//#check-types` task would re-enter the root script it is defined in. `check-type-fixture-programs.mjs` holds every tracked `scripts/**/*.mjs` outside `scripts/spikes/` to membership in that program, for the same reason it does so for `*.type-test.ts` — a file the `include` does not reach is checked by nothing and reads exactly like one that is.

The program does **not** extend `packages/config/tsconfig.base.json`, and two strictness flags are deliberately off:

| Flag | Why | Cost if turned on |
| --- | --- | --- |
| `moduleResolution` is `nodenext`, not the base's `bundler` | These files are run by `node`. `nodenext` turns a relative import missing its `.mjs` extension into `TS2835`, which is Node's own `ERR_MODULE_NOT_FOUND` reported before the script runs; `bundler` accepts a specifier Node rejects. | — |
| `noImplicitAny: false` | Pure "annotate every parameter" work that buys none of the shapes this program exists to check. About 60% of it is in the five `*.selftest.mjs` files. | **472** errors |
| `noUncheckedIndexedAccess: false` | Same. | a further **37** |

Full `strict` over the tree is 529 errors; the shape above was 28 when the program landed and is 0 now. Both flags are real slices with measured costs, not oversights.

**A new result union in `scripts/` needs a JSDoc `@typedef` or it is unchecked.** `checkJs` alone does not enforce one: TypeScript widens the `ok` of a fresh `return {ok: false, …}` / `{ok: true, …, payload}` pair to `boolean`, so the return type is not a discriminated union at all, nothing narrows, and reading the payload after a correct `if` guard becomes an error on correct code. A `@typedef` with a literal `ok: false` / `ok: true` plus `@returns` fixes both directions. `baselineEmission` and `loadBaseline` in `check-module-architecture.mjs` and `specifierKind` in `oxlint-config.mjs` are the worked examples.

A `.mjs` script cannot import a workspace package, so the repo's `toMessage` helper is unavailable in this tree: narrow a caught `error` locally with `error instanceof Error ? error.message : String(error)`. The consolidation gate does not reach these files either — `check-consolidation-drift.mjs` scans `*.ts` and `*.tsx` only.
