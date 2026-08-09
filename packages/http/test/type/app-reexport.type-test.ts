// Compile-only fixture for the transitional re-export in
// `packages/http/src/index.ts`. `@alfred/http` must resolve to the SAME route
// surface that `apps/server` mounts and `apps/web` types Eden against while
// `@alfred/api` still owns the root Elysia app.
//
// The test is compile-only because the runtime alternative is not viable:
// importing `@alfred/api`'s index executes `.mount(auth().handler)` at module
// load, so an identity assertion (`httpApp === apiApp`) would need real env and
// a live database, and a skipped test is not a pass.
//
// Assignability is asserted in BOTH directions on purpose. Elysia's `App` type
// is structurally huge, so a one-way check would still pass against a widened
// surface; only the pair pins the two types as equivalent.
//
// This file never runs — the node:test glob is `test/**/*.test.ts`. It is
// type-checked solely by `packages/http/tsconfig.test.json`, which
// `check-types` runs as its second `tsc` pass.
//
// Item 08 of the http-extraction campaign assembles the real root app in this
// package and deletes both the re-export and this fixture.

import type { App as LegacyApp } from "@alfred/api";
import type { App } from "@alfred/http";

// Exported (not bare `const`) to satisfy `noUnusedLocals`, matching the
// established `.type-test.ts` idiom in `@alfred/api` and `@alfred/sync`.
export const forward: App = null as unknown as LegacyApp;
export const backward: LegacyApp = null as unknown as App;
