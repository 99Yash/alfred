# Shared helpers — reach for these before writing new ones

Most low-level helpers you're about to write already exist and are heavily used.
The problem is never absence — it's discoverability. This doc is the front door:
a **smell map** (intent → the helper to reach for) and a **catalog** (what each
owner exports). Read it before adding a `format*`, `parse*`, `is*`, `to*`, or
`get*` function, or before dropping something into a route's `helpers.ts`.

Three layers find a helper for you, in increasing order of how much they trust
you to remember:

1. **`scripts/consolidation-rules.mjs`** — the machine-checked table.
   `check-consolidation-drift.mjs` runs its `gate` rules inside `pnpm check`, and
   `.claude/hooks/helper-hints.mjs` runs the whole table against code an agent is
   about to write. One table, two consumers, so a fact enforced by the build and
   a fact stated to an agent cannot disagree.
2. **This doc** — the full catalog and the colocation rule for helpers whose
   absence no regex can spot.
3. **`codebases guide alfred "<intent>"`** — semantic search over this repo's
   rules, and `codebases source alfred "<symbol>"` over its implementations. Use
   it when you don't know the name to look up. It is a discovery aid, never a
   gate: the local benchmark puts hybrid recall around half at top-5, so an
   invariant must never depend on it surfacing.

`pnpm dup` (jscpd) remains the _cure_ layer for copy-pasted bodies after the
fact. When a helper here has exactly one owner, a re-implementation of it is a
candidate `gate` rule — see [Closing the loop](#closing-the-loop).

## Smell map — when you're about to…, reach for

| You're about to write…                                                                        | Reach for                                                                                                                                                                                                                                                                                                          | From                          | Don't hand-roll                                                                                                                                                             |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a check that a _genuinely `unknown`_ value at a boundary is a plain object before indexing it | `isRecord(x)` / `toRecord(x)`                                                                                                                                                                                                                                                                                      | `@alfred/contracts`           | `typeof x === "object" && x !== null`                                                                                                                                       |
| coerce `unknown` into a `string[]`                                                            | `toStringArray(x)`                                                                                                                                                                                                                                                                                                 | `@alfred/contracts`           | `x as string[]` — **the drift check bans this**                                                                                                                             |
| read a nested field off `unknown`/parsed JSON                                                 | `getPath` / `getStringPath`                                                                                                                                                                                                                                                                                        | `@alfred/contracts`           | chained `?.` with casts                                                                                                                                                     |
| check a value is a present, non-empty string                                                  | `isNonEmptyString(x)`                                                                                                                                                                                                                                                                                              | `@alfred/contracts`           | `typeof x === "string" && x.length`                                                                                                                                         |
| turn a caught error into a display string                                                     | `toMessage(err)`                                                                                                                                                                                                                                                                                                   | `@alfred/contracts`           | `String(err)` / `err.message`                                                                                                                                               |
| redact secrets from an error/body before logging                                              | `redactSecrets` / `summarizeBody`                                                                                                                                                                                                                                                                                  | `@alfred/contracts`           | ad-hoc regex                                                                                                                                                                |
| fail a request with an HTTP status                                                            | `Errors.NotFoundError(msg)` and its 11 siblings                                                                                                                                                                                                                                                                    | `@alfred/contracts`           | `new ApiError(...)` or a new `extends ApiError` subclass — **the drift check bans both**                                                                                    |
| catch one of our own HTTP failures                                                            | `isApiError(err, "CONFLICT", …)`                                                                                                                                                                                                                                                                                   | `@alfred/contracts`           | a chain of per-kind `instanceof` tests                                                                                                                                      |
| parse **and** validate a JSON string                                                          | `parseJsonWith(raw, schema, fallback?)`                                                                                                                                                                                                                                                                            | `@alfred/contracts`           | `JSON.parse(...)` then a cast                                                                                                                                               |
| parse JSON that might be malformed, no schema                                                 | `safeJsonParse(raw)`                                                                                                                                                                                                                                                                                               | `@alfred/contracts`           | `try { JSON.parse } catch`                                                                                                                                                  |
| normalize / extract an email address                                                          | `parseEmailAddress(value)`                                                                                                                                                                                                                                                                                         | `@alfred/contracts`           | manual `<...>` / lowercase parsing                                                                                                                                          |
| fold a key to a canonical form                                                                | `canonicalParamKey(key)`                                                                                                                                                                                                                                                                                           | `@alfred/contracts`           | `.toLowerCase().replace(/[_-]/g, "")` — **drift check bans the raw idiom**                                                                                                  |
| strip tool-result / error noise before it hits a model                                        | `sanitizeToolResult` / `sanitizeErrorMessage`                                                                                                                                                                                                                                                                      | `@alfred/contracts`           | inline trimming                                                                                                                                                             |
| enforce Alfred's prose voice (no em-dashes, plain words)                                      | `sanitizeVoice` / `createVoiceStreamSanitizer`                                                                                                                                                                                                                                                                     | `@alfred/ai/voice`            | manual string replaces                                                                                                                                                      |
| read an environment variable                                                                  | `serverEnv()`                                                                                                                                                                                                                                                                                                      | `@alfred/env/server`          | `process.env.*` — **repo invariant**                                                                                                                                        |
| validate a timezone string                                                                    | `isIanaTimezone(value)`                                                                                                                                                                                                                                                                                            | `@alfred/contracts`           | `function isValidTimezone` / a raw `Intl.DateTimeFormat` trial — **drift check bans it**                                                                                    |
| any calendar-day, wall-clock, or UTC-offset reading                                           | `settings.resolveTimezone` for the zone, then the `@alfred/assistant/time` module — `inZone(tz).day()` / `.hour()` / `.dayBounds()` / `.startOf(key)` / `.clock()` / `.format(at)`, and `addDays` / `weekdayIndex` / `formatDay` on the key ([full list](#timezone--alfredassistanttime-packagesassistantsrctime)) | `@alfred/assistant/time`      | `Intl` glue per call site; day math in milliseconds; reading `getUTCDate()` off a user's instant; passing a bare `string` where `IanaTimezone` / `LocalDateKey` is expected |
| get a language-model handle and reasoning policy                                              | `route`                                                                                                                                                                                                                                                                                                            | `@alfred/ai`                  | constructing a provider client                                                                                                                                              |
| run a query and read typed rows                                                               | `rowsFromExecute` + named Drizzle row types                                                                                                                                                                                                                                                                        | `@alfred/db`                  | `(res as Row[])`                                                                                                                                                            |
| restrict a query or partial index to live `agent_runs`                                        | `runIsNotTerminal(t.status)`                                                                                                                                                                                                                                                                                       | `@alfred/db` schemas          | `status NOT IN ('completed', 'failed', 'cancelled')` written out per site                                                                                                   |
| merge Tailwind class names (web)                                                              | `cn(...)`                                                                                                                                                                                                                                                                                                          | `apps/web/src/lib/utils.ts`   | template-string concatenation                                                                                                                                               |
| capitalize / lower-first / relative-time a string (web)                                       | `capitalize` / `lowerFirst` / `formatRelative`                                                                                                                                                                                                                                                                     | `apps/web/src/lib/strings.ts` | inline `slice(0,1).toUpperCase()`                                                                                                                                           |

## Catalog — canonical owners

The heavy hitters, by owner. Import counts are approximate (from a workspace grep)
and just signal how load-bearing each surface is.

### Value-shape guards — `@alfred/contracts` (`src/guards.ts`)

Validate external / persisted / protocol data instead of asserting it.

- `isRecord`, `isIndexable`, `isNonEmptyString`
- `toRecord` (unknown → `Record` or `{}`), `toStringArray` (element-checked)
- `getPath`, `getStringPath` (safe nested read)
- `parseEmailAddress`

`isRecord` answers "is this a plain JSON object?" — a **boundary** question for a value that
arrived as `unknown`: unparsed JSON, a webhook body, a jsonb column with no type claim, a
provider trace. It is **not** a tool to re-open a value a schema already parsed. Applied to a
`z.infer` type, a Drizzle row type, or a locally-authored object it erases the established
shape back to `Record<string, unknown>`, and every field read has to rediscover a type the
parse already proved. If the field you want is typed, index it directly — absence already
shows up as `undefined`.

### Errors — `@alfred/contracts` (`src/errors.ts`)

- `toMessage` (~70 uses — the single most-imported helper)
- `redactSecrets`, `summarizeBody`, `MAX_ERROR_BODY_CHARS`
- `isHttpError`, `httpErrorFromResponse`
- We deliberately do **not** use Effect here — see the shared-error-primitives decision.

### Public failure catalog — `@alfred/contracts/app-errors` (`src/app-errors/index.ts`)

The one owner of every failure that a tool result, a tool card, or the `execute_error`
column carries. A public failure is `{ code, params?, message, fix }`. Consumers branch on
`fix.kind`, never on the message. Design: `docs/plans/typed-failures-v1.md`.

- `new AppError(code, params?, options?)` — throw from a tool body. A parametrized code
  (`connection_required`, `reauth_required`, `account_read_failed`,
  `integration_unavailable`) takes `{ integration }` first. `params` are closed enums or
  numbers, never free strings; the catalog type rejects a `z.string()` param, and the
  entry's own schema parses `params` at mint, so a widened code with bad params throws a
  `TypeError` that names only the code.
- `publicAppError(code, params?)` — mint a failure with no thrown error.
- `toPublicAppError(err, fallback?)` — project a caught value; anything that is not an
  `AppError` becomes the fallback, so exception text never crosses the boundary.
- `publicAppErrorFromStored(row)` — replay a persisted `execute_error`; re-validates
  `params` with the entry's schema and re-derives `message` and `fix`.
- `Fix`, `FIX_KINDS`, `isFixKind` — the closed remediation union. Switch with a `never`
  default. `FIX_KINDS` is derived from a record over `Fix["kind"]`, so it cannot lag the type.
- `INTEGRATION_DISPLAY_NAMES` (in `src/integrations.ts`) — the name every surface uses for a slug,
  indexed with a typed `IntegrationSlug`. `integrationDisplayName(value)` takes an unchecked
  string and falls back to `humanizeSlug`. `humanizeSlug(x.integration)` is a consolidation
  gate: it renders `github` as "Github".
- A code with no producer in `src/` fails `packages/contracts/test/app-errors.test.ts`.

### Integration registry — `@alfred/contracts` (`src/integrations.ts`)

One record per integration (ADR-0093). Every per-integration fact is a field on
`INTEGRATIONS[slug]`; every table keyed by an integration is a projection of it or an exhaustive
sibling keyed by a union derived from it. `pnpm check` fails on
`Partial<Record<IntegrationSlug, …>>` (rule `partial-integration-slug-record`).

- `INTEGRATIONS`, `integrationEntry(slug)` — the record and its typed index:
  `integrationEntry("github").credential.shape` is `"github_app"`.
- `liveProviders()` — the live entries with their slug attached, in registry order. The one loop
  the assistant and the web iterate.
- Derived unions (`LiveProviderSlug`, `PlannedSlug`, `CatalogSlug`, `LoadableIntegrationSlug`,
  `BearerSlug`, `GoogleSlug`, `CredentialProvider`, `SupportedPassthroughSlug`,
  `IntegrationBrandKey`) are mapped conditionals over the record, never hand-listed. Where a
  union has a runtime list (`LIVE_PROVIDER_SLUGS`, `CATALOG_SLUGS`, `BEARER_PROVIDER_SLUGS`,
  `CREDENTIAL_PROVIDERS`, …), the list is a `filter` over the tuple and its `is*` guard is an
  `enumGuard` of that list, so the two cannot disagree.
- `CREDENTIAL_SHAPE`, `GENERAL_INVOCATION_COVERAGE`, `PASSTHROUGH_TRANSPORT` — transitional
  projections. Read the entry field instead in new code; PR 4 of the registry plan deletes them.
- `src/google-scopes.ts` — the nine Google scope URLs, `GOOGLE_SCOPES`, `GOOGLE_FEATURE_SCOPES`.
  `@alfred/integrations/google` re-exports them beside the OAuth mechanics.

### HTTP failures — `@alfred/contracts` (`src/api-errors.ts`)

One class, one code table, one door. `HttpError` above is the _inbound_ failure of a
provider we called; `ApiError` is the _outbound_ failure we answer a client with.

- `Errors` — the factory namespace. Type `Errors.` and the editor lists all twelve
  (`BadRequestError`, `NotFoundError`, `ConflictError`, …) with status and meaning. No
  `new`, and nothing to import per kind.
- `ApiError` — the one class. `code` is the discriminant, `statusCode` is derived from
  it through `API_ERROR_STATUS`, so a call site cannot pair a status with a code that
  disagrees.
- `isApiError(err, ...codes)` — branch on the code. There is no per-kind class to test,
  on purpose: the code already travels on the wire.
- `apiErrorResponse` renders the wire body; `errorHandler` is the only caller that
  sets the status.

### JSON — `@alfred/contracts` (`src/json.ts`)

- `safeJsonParse`, `parseJsonWith` (overloaded: with/without fallback), `toJsonValue`

### Sanitize — `@alfred/contracts` (`src/sanitize.ts`)

- `sanitizeToolResult`, `sanitizeErrorMessage`

### Env — `@alfred/env/server`

- `serverEnv()` — the only sanctioned reader of process env.

### Timezone — `@alfred/assistant/time` (`packages/assistant/src/time/`)

Owns two concepts, and every `Intl` formatter, DST edge, and memo cache that
serves them. Nothing else in the API constructs an `Intl.DateTimeFormat` for a
date or a zone.
Two branded representations, so the compiler decides which slot a value fills
rather than the parameter name: a zone is an `IanaTimezone` and a calendar day is
a `LocalDateKey`. Before the brands, `localStartOfDay(timezone, key)` compiled.

**One question tells you which name to reach for: does the reading need a zone?**

- **Needs a zone → `inZone(tz)`**, which binds it once and hands back a
  `ZoneClock`. Every zone-dependent reading is a method on it, so nothing has to
  be recalled by name and the zone stops being an argument you can misorder:
  `.day(at?)` mints the `LocalDateKey`, `.hour(at?)` reads 0–23, `.offsetMs(at?)`
  is the only `longOffset` parse in the repo (**drift check bans a second
  copy**), `.clock(at?)` is the whole wall-clock reading in one pass,
  `.startOf(key, hour?)` turns a key back into an instant, `.dayBounds(at?)`
  brackets a local day (each bound converges on its own offset, so a transition
  day is correctly 23h or 25h), and `.format(at)` renders an instant. `at`
  defaults to now. Clocks are memoized per zone, so `inZone(tz).day()` inline is
  as cheap as holding one.
- **Doesn't need a zone → a free function on the key**: `addDays(key, n)` shifts
  it (day math happens on the key, never in milliseconds — a `+ 86_400_000`
  can't survive a DST transition), `weekdayIndex(key)` → `0`–`6` is the reading
  every weekend/weekday **decision** uses, and
  `formatDay(key, "short" | "long" | "weekday")` renders it in a closed style
  set. None of the three takes a zone, and that is the point: a key is already a
  calendar day, so re-projecting it through a zone is how a UTC+14 user got the
  wrong weekday. Never compare a _rendered_ weekday name to `"Saturday"`; that
  made a formatter's locale choice load-bearing for a briefing decision in
  another file.
- **Which zone** (`IanaTimezone`): `settings.resolveTimezone`, `firstValidTimezone`,
  `DEFAULT_USER_TIMEZONE`. At a boundary, `parseIanaTimezone` /
  `ianaTimezoneSchema` / `isIanaTimezone` (`@alfred/contracts`).
- **A day key from outside** enters through `parseLocalDateKey` (throws) or
  `isLocalDateKey` (for a Zod `refine` or a filter). Both reject a truncated key
  _and_ a day that doesn't exist — a bare `/^\d{4}-\d{2}-\d{2}$/` accepts
  `"2026-02-30"`, which `Date.UTC` then rolls over in silence.

### DB — `@alfred/db`

- `db`, the schema table objects (`user`, `documents`, `emailTriage`, `agentRuns`,
  `userFacts`, `integrationCredentials`, `apiCallLog`, …), `rowsFromExecute`
- Lifecycle: `closeConnections`, `warmPool`, `closeRedis`; type `DbTransaction`
- Run-status SQL: `runIsNotTerminal(status)` — the one "this run is still live"
  predicate, shared by the `agent_runs` partial indexes and the queries they
  back. Built from `TERMINAL_RUN_STATUSES`, so a new run status reaches every
  site at once; a hand-written `NOT IN (…)` next to one of those indexes is how
  an index quietly stops enforcing what its query looks for.
- Event-run identity: `eventRunIdentityMatch(table, identity)` and
  `EVENT_ACTIVE_RUN_INDEX` / `RUN_DEDUP_KEY_INDEX` / `CHAT_THREAD_ACTIVE_RUN_INDEX`
  — a dispatcher catching a `23505` has to know which invariant collided, because
  only some of them mean "duplicate, drop it".
- `isDuplicateRunIndex(uniqueViolationConstraint(err))` — that question, asked
  once. Each index's collision meaning is declared in
  `AGENT_RUN_UNIQUE_INDEX_MEANING` (`satisfies Record<AgentRunUniqueIndex, …>`), so
  a new discriminated index has to state whether its loser is a dropped duplicate
  or a busy resource. Don't hand-roll a null check plus an `.includes` against a
  local list of index names.

### Models — `@alfred/ai`

- `route`

### Web-local — `apps/web/src/lib/`

- `cn` (`utils.ts`), `capitalize`/`lowerFirst`/`formatRelative` (`strings.ts`),
  `formatCost`/`formatTokens` (`usage-format.ts`), `asRecord`/`parseJsonRecord`
  (`json-record.ts` — prefer the contracts guards for anything reusable)

## Where new helpers go (colocation rule)

1. **Cross-boundary and browser-safe** (used by web _and_ server, no Node deps) →
   `@alfred/contracts`, in the domain file that fits (`guards`, `json`, `errors`,
   `sanitize`, …). This is the reuse home.
2. **Server-only but shared across features** → the owning `@alfred/*` package
   (timezone glue → the timezone module, model glue → `@alfred/ai`, etc.).
3. **Feature-local** → colocate inside the feature. But before adding to a route's
   `helpers.ts`, check the smell map above — most "helpers" are steps 1 or 2.
4. **Do not** create a new grab-bag `utils.ts` / `helpers.ts` for something generic.
   If it's reusable it belongs in a named owner; a junk drawer has no front door
   and is exactly where duplicates breed.

## Consolidation notes

A structural sweep found far less genuine scatter than the raw name-counts
suggested — most apparent "clusters" were single owners plus their imports, or
deliberate wrapper patterns, or throwaway scripts.

**Resolved:** `isValidTimezone` was defined identically in three boundaries
(`apps/web/.../plan-tab.tsx`, `packages/sync/src/mutators/workflows.ts`, and
`packages/assistant/src/briefings/preferences.ts`). All three now route through
the pre-existing, better `isIanaTimezone` in `@alfred/contracts` (memoized +
alias-aware; a bare `Intl.DateTimeFormat` trial once broke briefings on `"UTC"`).
`packages/assistant/src/time/user-timezone.ts` keeps `isValidTimezone` as a
one-line alias of `isIanaTimezone` so its call sites read in domain terms. Guarded by a `check-consolidation-drift.mjs`
rule that bans a hand-rolled `function isValidTimezone`.

**Not a target (deliberate pattern):** the four `getJson` in the Google
integration (`docs`/`calendar`/`drive`/`gmail`) are 2-line wrappers that bind a
service tag onto the single `googleJson` transport in `google/http.ts` — the
documented per-module vocabulary pattern, not duplication. jscpd doesn't flag
them (below its 8-line floor). Leave them.

**Not a target (throwaway):** the `parseTargetEmails` / `resolveTargets` /
`parseEmails` repeats all live in one-shot `server/src/scripts/backfills/*-committed.ts`.
Self-contained committed migration scripts; copy-paste there is intended and the
tooling already ignores `scripts/`.

## Closing the loop

A prose row and a deterministic gate express the same fact twice, so the goal is
to keep as few facts as possible in prose only. `scripts/consolidation-rules.mjs`
carries two severities to make that a ratchet rather than a one-time cleanup:

- **`hint`** — the canonical helper exists and is preferred, but legacy call
  sites remain (or the pattern is too broad to ban). Advisory: the agent hook
  names the helper at edit time; nothing fails.
- **`gate`** — fully consolidated to one owner, so a match is unambiguously
  drift. Fails `pnpm check` the same way a type error does.

The ratchet: when a `hint` rule's legacy call sites reach zero, promote it to
`gate` **and delete its row from the root `CLAUDE.md` table**. A fact a check
enforces should not also be prose that every session pays for and nothing keeps
current. That trade is what makes the trim a real simplification rather than a
move — the enforcement went up as the prose went down.

Worked example: `err instanceof Error ? err.message : String(err)` sat out of the
gate for a long time on the belief that it had ~95 un-migrated call sites. It had
five. Migrating them cost one commit, `error-to-message` became a `gate` rule,
and the `toMessage` row left the root table. Re-derive a count before trusting it
as a reason not to enforce something.

Keep the layers in step: a new `gate` rule should retire a prose row, and a new
prose row should be a question of whether a rule could cover it instead.
