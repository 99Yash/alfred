# Alfred API Guidance

`@alfred/api` owns the authenticated HTTP surface, server-side workflow orchestration, and Replicache server protocol.

Use `@alfred/api` only for the Elysia app, its `App` type, and HTTP security headers. Import reusable server services from `@alfred/api/backend` and worker/bootstrap/teardown operations from `@alfred/api/runtime`.

## Boundaries

- Validate request, webhook, workflow, tool, event, and Replicache payloads with the owning schema before domain code sees them. Derive types from that schema rather than recasting parsed output.
- Keep routes thin: authentication/authorization, transport validation, domain delegation, and response mapping. Reusable domain behavior belongs in the owning module, not route handlers.
- New routes must remain under the shared auth, rate-limit, and error lifecycle. Paginate lists and make retryable writes idempotent.
- Keep multi-step writes atomic. Replicache server mutators must use the transaction supplied by the push handler and preserve row-version semantics.

## Runtime Values

- JSON/protocol guards are for JSON-shaped values. Drizzle errors, timer handles, SDK instances, and other runtime objects require checks for the specific property or method being used.
- Bound and sanitize tool output and error text before persistence, transport, or logging. Never log full error objects.
- User-model writes must go through the existing observation/fact write boundaries and schemas; do not insert raw rows directly.
