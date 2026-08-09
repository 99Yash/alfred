// Compile-only fixture for `@alfred/http`'s middleware barrel
// (`packages/http/src/index.ts`). The barrel is the seam this package's
// consumers see: `apps/server` composes `securityHeaders`, and 17 files under
// `packages/api/src` reach the other four bindings through the package
// specifier rather than the relative paths they used before the move.
//
// The fixture is compile-only because the runtime alternative is not viable
// here: `session-cache` calls `@alfred/auth`, so exercising `authMacro` for
// real needs env and a live database, and a skipped test is not a pass. This
// file never runs — `@alfred/http` has no test script (campaign item 19 owns
// adding one). It is type-checked solely by `packages/http/tsconfig.test.json`,
// which `check-types` runs as its second `tsc` pass, after the composite
// `tsc -b` that only ever sees `src`.
//
// Every binding below is mutation-tested: dropping the matching `export` from
// the barrel, or dropping `.use(authMacro)` from `probe`, turns this file red.

import {
  authMacro,
  errorHandler,
  getSessionCached,
  invalidateSessionToken,
  securityHeaders,
  type SecurityHeadersOptions,
} from "@alfred/http";
import { Elysia } from "elysia";

// The one thing the move actually changes: Elysia's macro type inference has to
// survive being resolved through a PACKAGE specifier instead of a relative
// path. `{ auth: true }` is only accepted, and `user` is only in scope, if the
// `authMacro` plugin's macro types crossed the package boundary intact.
// Exported (not bare `const`) to satisfy `noUnusedLocals`, matching the
// established `.type-test.ts` idiom in `@alfred/api` and `@alfred/sync`.
export const probe = new Elysia()
  .use(authMacro)
  .get("/probe", ({ user }) => user.id, { auth: true });

// `errorHandler` is a ready-made plugin instance, not a factory.
export const errorHandled = new Elysia().use(errorHandler);

// `securityHeaders` IS a factory, and its options argument is the exported
// type. Both call shapes are load-bearing: `apps/server` passes an object,
// `test/security-headers.test.ts` calls it bare.
export const headerOptions: SecurityHeadersOptions = { hsts: true };
export const headed = new Elysia().use(securityHeaders(headerOptions)).use(securityHeaders());

// The session-cache pair. `getSessionCached` takes a `Request` and resolves to
// a session or `null`; `invalidateSessionToken` takes `Headers` and returns
// nothing. Pinning the parameter types is what catches the two being swapped.
export const readSession: (request: Request) => Promise<{ user: { id: string } } | null> =
  getSessionCached;
export const dropSession: (headers: Headers) => void = invalidateSessionToken;
