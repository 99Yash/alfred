// Transitional re-export. `@alfred/api` still owns the root Elysia app; this
// package exists so the later transport slices have a destination to move into
// one at a time.
//
// While these two lines exist, `@alfred/api` must NOT import `@alfred/http`.
// The edge here is `@alfred/http -> @alfred/api`; the opposite edge closes a
// package cycle and `scripts/check-module-architecture.mjs` fails with `new
// cyclic package edge`.
//
// That makes the FIRST slice which moves a file `@alfred/api` still consumes
// the owner of this file's deletion — campaign item 03 (it moves
// `packages/api/src/middleware/*` here while 17 files under `packages/api/src`
// still import that middleware, so it cannot avoid the back-edge). Item 03
// deletes these two lines and `test/type/app-reexport.type-test.ts` with them,
// or moves enough of api's consumers that api needs nothing from http.
export { app } from "@alfred/api";
export type { App } from "@alfred/api";
