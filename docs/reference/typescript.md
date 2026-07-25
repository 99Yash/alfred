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
