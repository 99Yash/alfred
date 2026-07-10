# TypeScript conventions

- TypeScript is pinned through the workspace catalog and every workspace declaration must use `"typescript": "catalog:"`. Keeping one compiler version avoids duplicate peer-instantiated library types.
- All packages use `"moduleResolution": "bundler"` and `"verbatimModuleSyntax": true`. Use `import type` for type-only imports.
- `apps/web` uses `tsc --noEmit` for type-checking (not `tsc -b`) — it's a leaf node, not a composite project.
- All other packages use `tsc -b` via composite project references.
- Workspace packages export TS source directly (`./src/index.ts`), so `pnpm check-types` works on a fresh tree without a prior build.
- Private workspace packages build declarations directly with native `tsc -b --emitDeclarationOnly --force`; they do not bundle their source. `tsdown` is reserved for the production server, where it bundles workspace source and committed operational scripts into plain Node.js output.
- When reading unfamiliar library APIs, inspect type definitions in `node_modules/.pnpm/*/node_modules/<pkg>/dist/*.d.ts` — do not guess from old docs or training data.
