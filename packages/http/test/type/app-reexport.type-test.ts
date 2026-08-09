// Compile-only fixture for the transitional re-export in
// `packages/http/src/index.ts`. `@alfred/http` must resolve to the SAME `app`
// value and the SAME route surface that `apps/server` mounts and `apps/web`
// types Eden against while `@alfred/api` still owns the root Elysia app.
//
// The test is compile-only because the runtime alternative is not viable:
// importing `@alfred/api`'s index executes `.mount(auth().handler)` at module
// load, so an identity assertion (`httpApp === apiApp`) would need real env and
// a live database, and a skipped test is not a pass. `typeof import(...)` below
// is type-space only, so it reads the module's type without loading it.
//
// Assignability is asserted in BOTH directions on purpose. Elysia's `App` type
// is structurally huge, so a one-way check would still pass against a widened
// surface; only the pair pins the two types as equivalent.
//
// This file never runs — `@alfred/http` has no test script. It is type-checked
// solely by `packages/http/tsconfig.test.json`, which `check-types` runs as its
// second `tsc` pass.
//
// Campaign item 03 deletes this fixture together with the re-export it guards
// (see the comment in `packages/http/src/index.ts`).

import type { App as LegacyApp } from "@alfred/api";
import type { App } from "@alfred/http";

// Exported (not bare `const`) to satisfy `noUnusedLocals`, matching the
// established `.type-test.ts` idiom in `@alfred/api` and `@alfred/sync`.
export const forward: App = null as unknown as LegacyApp;
export const backward: LegacyApp = null as unknown as App;

// The `App` pair above says nothing about the `app` VALUE binding: dropping
// `export { app }` from `packages/http/src/index.ts`, or binding it to a
// separately constructed Elysia, leaves both assertions above compiling. These
// two pin the exported value's type instead, so the whole re-export — not half
// of it — is under guard.
type HttpApp = typeof import("@alfred/http").app;
type LegacyApiApp = typeof import("@alfred/api").app;

export const forwardValue: HttpApp = null as unknown as LegacyApiApp;
export const backwardValue: LegacyApiApp = null as unknown as HttpApp;
