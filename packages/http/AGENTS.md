# Alfred HTTP Guidance

`@alfred/http` owns Alfred's Elysia transport adapters and the composed root `app`. Its derived `App`
type is the Eden client contract. `apps/server` adds process lifecycle, server middleware, the Node adapter,
and the listener around this app.

## Package Door

- Keep one root package door. Import concrete sibling modules from `packages/http/src/**`; never import
  `@alfred/http` or `src/index.ts` back into the package.
- Keep the root app's route order, health and readiness checks, cached-session endpoint, sign-out
  invalidation hook, and final Better Auth mount stable unless a product change requires different behavior.
- Derive `App` from the composed value with `typeof app`. Do not widen the app or its type to `any`.

## Load Boundary

- Importing `@alfred/http` must not read service environment or start a database, Redis connection, or
  socket. Keep resource construction inside request-time functions.
- Better Auth needs the server environment and database adapter. The final mount must call `auth()` inside
  its request handler, not while the barrel loads.
- The session cache has one pre-existing unref'd sweep timer. Do not add another module-scope handle.

## Transport Boundary

- Validate external and protocol data with the owning schema before domain code sees it. Derive types from
  that schema instead of asserting parsed values.
- Keep routes thin: authentication, authorization, transport validation, domain delegation, and response
  mapping. Product behavior belongs in `@alfred/assistant`.
