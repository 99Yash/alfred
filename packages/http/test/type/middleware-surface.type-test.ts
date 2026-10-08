// Compile-only fixture for the middleware half of the `@alfred/http` barrel.
// Compile-only because running `authMacro` needs env and a live database.
// It never runs (`.type-test.ts` misses the `test` glob); `tsconfig.test.json` type-checks it.

import {
  authMacro,
  errorHandler,
  getSessionCached,
  invalidateSessionToken,
  securityHeaders,
  type SecurityHeadersOptions,
} from "@alfred/http";
import { Elysia } from "elysia";

// Elysia macro types must survive the package specifier: `{ auth: true }` and `user` need them.
// Exported to satisfy `noUnusedLocals`.
export const probe = new Elysia()
  .use(authMacro)
  .get("/probe", ({ user }) => user.id, { auth: true });

// A plugin instance, not a factory.
export const errorHandled = new Elysia().use(errorHandler);

// A factory. `apps/server` passes options; `security-headers.test.ts` calls it bare.
export const headerOptions: SecurityHeadersOptions = { hsts: true };

export const headed = new Elysia().use(securityHeaders(headerOptions)).use(securityHeaders());

// Pin both signatures, so swapping the two fails.
export const readSession: (request: Request) => Promise<{ user: { id: string } } | null> =
  getSessionCached;

export const dropSession: (headers: Headers) => void = invalidateSessionToken;
