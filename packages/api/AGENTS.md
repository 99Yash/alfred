# Alfred API Guidance

`@alfred/api` is the legacy server-side workflow and runtime facade. The authenticated HTTP surface,
root Elysia app, derived `App` type, middleware, routes, SSE, webhooks, and Replicache protocol live in
`@alfred/http`.

Do not import the package root. Import reusable server services from `@alfred/api/backend` and
worker/bootstrap/teardown operations from `@alfred/api/runtime` until their owning migration items remove
these transitional doors.

## Boundaries

- Validate request, webhook, workflow, tool, event, and Replicache payloads with the owning schema before domain code sees them. Derive types from that schema rather than recasting parsed output.
- Keep routes thin: authentication/authorization, transport validation, domain delegation, and response mapping. Reusable domain behavior belongs in the owning module, not route handlers.
- New routes must remain under the shared auth, rate-limit, and error lifecycle. Paginate lists and make retryable writes idempotent.
- Keep multi-step writes atomic. Replicache server mutators must use the transaction supplied by the push handler and preserve row-version semantics.

## Runtime Values

- JSON/protocol guards are for JSON-shaped values. Drizzle errors, timer handles, SDK instances, and other runtime objects require checks for the specific property or method being used.
- Bound and sanitize tool output and error text before persistence, transport, or logging. Never log full error objects.
- User-model writes must go through the existing observation/fact write boundaries and schemas; do not insert raw rows directly.
- The `time` module (now `@alfred/assistant/time`, transitionally re-exported through `@alfred/api/backend`) owns every calendar-day, wall-clock, and UTC-offset reading, and owns the two types those readings travel as: a zone is an `IanaTimezone` and a calendar day is a `LocalDateKey`, so neither can be passed where the other belongs. One question picks the name: **does the reading need a zone?** If it does, `settings.resolveTimezone` gets the zone and `inZone(tz)` binds it — `.day()` mints the day key, `.hour()`, `.offsetMs()`, `.clock()`, `.startOf(key, hour?)`, `.dayBounds()`, `.format(instant)`. If it doesn't, it is a free function on the key — `addDays`, `weekdayIndex` for a day-of-week decision, `formatDay(key, style)` for rendering — and none of them takes a zone by design. A plain string crossing in from persistence or a wire payload is parsed at that boundary — `parseLocalDateKey` / `isLocalDateKey` for a day, `parseIanaTimezone` / `ianaTimezoneSchema` / `isIanaTimezone` (`@alfred/contracts`) for a zone. Do not write `Intl` glue per call site, do not do day arithmetic in milliseconds, do not read a day off a user-facing instant with `getUTCDate()` (that is how a rail todo dated itself a day early), and do not decide anything by string-matching a rendered weekday name.
- Pass agent-authored prose through `sanitizeVoice` (or `createVoiceStreamSanitizer` when streaming) before it reaches a user. The prompt asks for the voice; the sanitizer is what enforces it.
- Worker, bootstrap, and teardown entrypoints come from `@alfred/api/runtime` — `warmPool` on start, `closeConnections` / `closeRedis` on shutdown. A process that skips them leaks pooled connections.
