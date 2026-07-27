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
- The `timezone` module owns every calendar-day, wall-clock, and UTC-offset reading: `resolveUserTimezone` for the zone, `localDateInTimezone` / `addLocalDays` for the local date key, `dayBoundsInTimezone` / `localStartOfDay` for a key's instants, `offsetMsAt` / `formatUtcOffset` for the offset, and `formatInstantInTimezone` / `formatLocalDayShort` / `formatLocalDayLong` for rendering. Validate a zone string with `isIanaTimezone` from `@alfred/contracts`. Do not write `Intl` glue per call site, do not do day arithmetic in milliseconds, and never read a day off a user-facing instant with `getUTCDate()` — that is how a rail todo dated itself a day early.
- Pass agent-authored prose through `sanitizeVoice` (or `createVoiceStreamSanitizer` when streaming) before it reaches a user. The prompt asks for the voice; the sanitizer is what enforces it.
- Worker, bootstrap, and teardown entrypoints come from `@alfred/api/runtime` — `warmPool` on start, `closeConnections` / `closeRedis` on shutdown. A process that skips them leaks pooled connections.
