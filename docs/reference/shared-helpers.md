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
   A fact that only the syntax tree can state (scope, nesting, read versus
   write, which import binds a re-exported or aliased name) is an AST rule in
   `scripts/oxlint/alfred/` instead, which `pnpm lint` enforces. The
   second-door rules for constants and types (`no-constants-re-export`,
   `no-type-re-export-shim`, `no-type-alias-shim`) live there.
   `helper-hints.mjs` does not read it. `.claude/hooks/lint-on-edit.mjs`
   runs oxlint with the root config on each `.ts`/`.tsx` file an agent writes,
   so those rules also speak at edit time. Both hooks are registered in the
   tracked `.claude/settings.json`. Claude Code asks each user to trust project
   hooks before it runs them.
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

`pnpm check:knip` holds unused files, exports, types and dependencies at zero,
in `pnpm check` and in CI. A dead export is where a second helper starts: it
looks like an owner, so the next caller wraps it instead of finding the live
one. Delete it, or drop `export` when only its own module reads it. An export
that knip cannot see reaching (an Eden `typeof app` inference, for example) is
intentional API: tag it `/** @public */` with the reason, and do not un-export
it. Policy and every blind spot live in `knip.json`.

## Smell map — when you're about to…, reach for

| You're about to write…                                                                        | Reach for                                                                                                                                                                                                                                                                                                          | From                          | Don't hand-roll                                                                                                                                                             |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a check that a _genuinely `unknown`_ value at a boundary is a plain object before indexing it | `isRecord(x)` / `toRecord(x)`                                                                                                                                                                                                                                                                                      | `@alfred/contracts`           | `typeof x === "object" && x !== null`                                                                                                                                       |
| an `is*` guard for "is this string a key of TABLE?" or "a member of TUPLE?" | `keyGuard(TABLE)` / `enumGuard(TUPLE)` | `@alfred/contracts` | `Object.hasOwn(TABLE, x)`, `Object.prototype.hasOwnProperty.call(TABLE, x)`, `(TUPLE as readonly string[]).includes(x)` — the `hand-rolled-key-guard` gate and the `hand-rolled-enum-guard` hint name the helper |
| read the keys or entries of a closed const table as its key union, or build a record over a key tuple | `typedKeys(TABLE)` / `typedEntries(TABLE)` / `recordFromKeys(KEYS, fn)` / `pluckField(TABLE, "field")`; close a loop-filled `Partial<Record<K, V>>` with `hasEveryKey(record, KEYS)` | `@alfred/contracts` | `Object.keys(TABLE) as K[]`, `Object.fromEntries(…) as Record<K, V>`, `{} as Record<K, V>` — the `object-keys-cast` hint names the helper |
| coerce `unknown` into a `string[]`                                                            | `toStringArray(x)`                                                                                                                                                                                                                                                                                                 | `@alfred/contracts`           | `x as string[]` — **the drift check bans this**                                                                                                                             |
| read `documents.metadata` for a row | `parseDocumentMetadata({ source, metadata })`, then narrow on `.source`; `parseGmailDocumentMetadata` / `parseGmailAttachmentMetadata` when the source is fixed | `@alfred/contracts` | `getPath(row.metadata, "…")`, an `isRecord(row.metadata)` gate, or a local zod parse of one key |
| read `ingestion_state.state` or `integration_credentials.metadata` (writers merge keys) | `parseGmailIngestionState`, `parseGoogleCredentialMetadata`, `readVercelTeamId`; a new one wraps `parsePersistedMetadata(schema, raw)` | `@alfred/contracts` (`parseGmailIngestionState`), `@alfred/integrations/google` (`parseGoogleCredentialMetadata`); `readVercelTeamId` lives beside its only reader in `packages/integrations/src/vercel/credential.ts` | `getPath(row.state, ...)` / `getPath(row.metadata, ...)` or a local zod parse of one key |
| read a stored `agent_runs.metadata` row for a chat-turn or sub-agent run (one shape per `workflow_slug`, no `$type`) | `readChatTurnRunMetadata` (lenient per key), `readSubAgentMetadata` (all-or-nothing on the `subAgent` key) | `@alfred/assistant/chat/chat-turn-run-metadata`, `packages/assistant/src/execution/sub-agent-metadata.ts` | `getPath(row.metadata, ...)` or a local zod parse of one key |
| read `metadata` or `input` in a workflow start hook (`initialState`, `initialTranscript`, `dedupKey`) | the workflow's own `metadataSchema` / `inputSchema`; `createRun` parses each one time and the hooks get its output, typed only when the `Workflow` annotation names `M` or `I` | `packages/assistant/src/execution/registry.ts` (`Workflow`) | a reader call or `<schema>.parse(input.input ?? {})` inside a hook |
| read a stored Gmail `documents.raw` | `parseStoredGmailMessage(raw)` one time, then read the typed message | `@alfred/integrations/google` | `getPath(raw, "payload", "headers")` |
| the Google scopes a read or a named grant needs (`gmail`, `gmail_modify`, `calendar_write`, …) | `googleAuthorityScopes(authority)`; the registry entry owns the list (`credential.anyOfScopes` = read, `credential.grants` = the other grants) | `@alfred/contracts` | a `[GOOGLE_SCOPE.gmail.modify]` literal or a per-file `*_SCOPES` constant |
| decide whether a credential row counts as "connected" for a registry entry | `credentialSatisfies(entry.credential, row)` | `@alfred/contracts` | `status === "active" && holdsAnyScope(...)` |
| read a nested field off `unknown`/parsed JSON                                                 | `getPath` / `getStringPath` / `getIdPath` (string-or-integer id to one string)                                                                                                                                                                                                                                                                                     | `@alfred/contracts`           | chained `?.` with casts                                                                                                                                                     |
| check a value is a present, non-empty string                                                  | `isNonEmptyString(x)`                                                                                                                                                                                                                                                                                              | `@alfred/contracts`           | `typeof x === "string" && x.length`                                                                                                                                         |
| read an optional field as a non-empty string or a finite number (`""`, `NaN`, `Infinity` read as absent) | `toNonEmptyString(x)` / `toFiniteNumber(x)` | `@alfred/contracts` | `isNonEmptyString(x) ? x : undefined`, or `getStringPath` where `""` must fall through a `??` chain |
| turn a caught error into a display string                                                     | `toMessage(err)`                                                                                                                                                                                                                                                                                                   | `@alfred/contracts`           | `String(err)` / `err.message`                                                                                                                                               |
| redact secrets from an error/body before logging                                              | `redactSecrets` / `summarizeBody`                                                                                                                                                                                                                                                                                  | `@alfred/contracts`           | ad-hoc regex                                                                                                                                                                |
| fail a request with an HTTP status                                                            | `Errors.NotFoundError(msg)` and its 11 siblings                                                                                                                                                                                                                                                                    | `@alfred/contracts`           | `new ApiError(...)` or a new `extends ApiError` subclass — **the drift check bans both**                                                                                    |
| catch one of our own HTTP failures                                                            | `isApiError(err, "CONFLICT", …)`                                                                                                                                                                                                                                                                                   | `@alfred/contracts`           | a chain of per-kind `instanceof` tests                                                                                                                                      |
| parse **and** validate a JSON string                                                          | `parseJsonWith(raw, schema, fallback?)`                                                                                                                                                                                                                                                                            | `@alfred/contracts`           | `JSON.parse(...)` then a cast                                                                                                                                               |
| parse JSON that might be malformed, no schema                                                 | `safeJsonParse(raw)`                                                                                                                                                                                                                                                                                               | `@alfred/contracts`           | `try { JSON.parse } catch`                                                                                                                                                  |
| parse a `From:`-style mailbox | `parseMailbox(value)` → `{ displayName, address, localPart, domain }` (the `splitEmail` form: one `@`, lowercase, trailing dot dropped) / `mailboxLabel(value)` (name, else address, else the trimmed raw text) / `splitAddressList(value)` (a quote-aware To/Cc split) | `@alfred/contracts` | manual `<...>` / lowercase parsing, `split("@")[1]` — **drift check bans the domain split** |
| normalize / extract an email address | `parseEmailAddress(value)` (LOOSE: `parseMailbox(value)?.address`; the single source of self-mail matching) / `normalizeEmailAddress(value)` (STRICT: the same, then `mailto:` stripping and a `z.email()` shape check) / `parseEmailIdentity(value)` (the canonical `email` identity value, or null) | `@alfred/contracts` | a manual lowercase, or a local `canonicalizeIdentityValue("email")` + `identityRefSchema` pair |
| read the domain off an email address | `emailDomain(value)`, or `splitEmail(value)` when you need the local part too | `@alfred/contracts` | a manual `@` split, a second domain regex |
| test that a domain is a base domain or a subdomain of it | `isDomainOrSubdomain(domain, base)` (case-sensitive: pass normalized values, as `emailDomain` returns them) | `@alfred/contracts` | `` d === base \|\| d.endsWith(`.${base}`) `` — **drift check bans the raw idiom**; a regex `.test(from)` over the raw sender header, which also matches the display name and a look-alike host |
| parse an OAuth `scope` response field into scopes                                             | `parseOAuthScopeList(scope)`                                                                                                                                                                                                                                                                                       | `@alfred/contracts`           | `scope.split(/\s+/)` — loses GitHub's comma list; **drift check bans the raw idiom**                                                                                       |
| fold a key to a canonical form                                                                | `canonicalParamKey(key)`                                                                                                                                                                                                                                                                                           | `@alfred/contracts`           | `.toLowerCase().replace(/[_-]/g, "")` — **drift check bans the raw idiom**                                                                                                  |
| collapse a whitespace run to one space for **display** text | `collapseWhitespace(text)` | `@alfred/contracts` | `.replace(/\s+/g, " ").trim()`, and the `/\s{2,}/` and `/\s\s+/` spellings of the same run — **drift check bans the raw idiom**. A value other code compares byte for byte keeps its own fold, under a per-line `// drift-ok:` reason or the rule's `owners` list — the two exemptions are not interchangeable, see below. |
| escape text for HTML, or decode the HTML entities in fetched or mail text | `escapeHtml(text)` / `decodeHtmlEntities(text)` (one pass, so `&amp;lt;` reads `&lt;`; the tag strip stays with each caller) | `@alfred/contracts` | a private `escapeHtml`, a chain of `.replace(/&amp;/g, "&")` calls, a second entity table |
| close an exhaustive `switch` on a union | `assertNever(value, "what")` (the inline `const _: never = value` form stays legal) | `@alfred/contracts` | a private `assertNever` per file |
| check an embedding vector has the stored dimension | `assertEmbeddingDimensions(vector, context)` | `@alfred/ai/embeddings` | a literal `1024` or a local `EMBEDDING_DIMENSIONS` compare |
| wait a delay on the server | `setTimeout as sleep` | `node:timers/promises` | `new Promise((resolve) => setTimeout(resolve, ms))` in a local `sleep` |
| strip tool-result / error noise before it hits a model                                        | `sanitizeToolResult` / `sanitizeErrorMessage`                                                                                                                                                                                                                                                                      | `@alfred/contracts`           | inline trimming                                                                                                                                                             |
| enforce Alfred's prose voice (no em-dashes, plain words)                                      | `sanitizeVoice` / `createVoiceStreamSanitizer`                                                                                                                                                                                                                                                                     | `@alfred/ai/voice`            | manual string replaces                                                                                                                                                      |
| read an environment variable                                                                  | `serverEnv()`                                                                                                                                                                                                                                                                                                      | `@alfred/env/server`          | `process.env.*` — **repo invariant**                                                                                                                                        |
| validate a timezone string, or declare a zod timezone field | `isIanaTimezone(value)` to check a string; `ianaTimezoneSchema` for a zod field                                                                                                                                                                                                                                                                                            | `@alfred/contracts`           | `function isValidTimezone` / a raw `Intl.DateTimeFormat` trial — **drift check bans it**                                                                                    |
| any calendar-day, wall-clock, or UTC-offset reading                                           | `settings({ userId }).timezone()` for the zone, then the `@alfred/assistant/time` module — `inZone(tz).day()` / `.hour()` / `.dayBounds()` / `.startOf(key)` / `.clock()` / `.format(at)`, and `addDays` / `weekdayIndex` / `formatDay` on the key ([full list](#timezone--alfredassistanttime-packagesassistantsrctime)). A tool reads `ctx.timezone`; a durable step reads its own snapshot, not a live read | `@alfred/assistant/time`      | `Intl` glue per call site; day math in milliseconds; reading `getUTCDate()` off a user's instant; passing a bare `string` where `IanaTimezone` / `LocalDateKey` is expected |
| get a language-model handle and reasoning policy                                              | `route`                                                                                                                                                                                                                                                                                                            | `@alfred/ai`                  | constructing a provider client                                                                                                                                              |
| hash a JSON value for dedup, idempotency, or change detection | `sha256Canonical(value)` | `@alfred/db/hash` | `createHash("sha256").update(JSON.stringify(v))` — key-insertion-order dependent; **the `alfred/sha256-over-json-stringify` lint rule bans it** |
| hash raw text (a document body, a key, a prompt) to hex | `sha256Hex(text)` | `@alfred/db/hash` | an exported `createHash("sha256").update(text).digest("hex")` helper in another module — **the `alfred/no-exported-hasher` lint rule bans it** |
| run a raw `execute(sql…)` and read typed rows | `rowsFromExecute(result, schema)` with a zod schema next to the query; `createExecuteRowSchema(table)` for whole-table rows (it coerces timestamp text to `Date`) | `@alfred/db`                  | `(res as Row[])`                                                                                                                                                            |
| restrict a query or partial index to live `agent_runs`                                        | `runIsNotTerminal(t.status)`                                                                                                                                                                                                                                                                                       | `@alfred/db` schemas          | `status NOT IN ('completed', 'failed', 'cancelled')` written out per site                                                                                                   |
| merge Tailwind class names (web)                                                              | `cn(...)`                                                                                                                                                                                                                                                                                                          | `apps/web/src/lib/utils.ts`   | template-string concatenation                                                                                                                                               |
| capitalize / lower-first a string (web)                                       | `capitalize` / `lowerFirst`                                                                                                                                                                                                                                                                     | `apps/web/src/lib/strings.ts` | inline `slice(0,1).toUpperCase()`                                                                                                                                           |
| show a date or a relative time (web) | `formatDateTime(iso, { today, yesterday, year, locale, invalid })` / `formatRelative(iso, { style, invalid })`; with no options each gives the plain text, and each option opts one caller into one rule | `apps/web/src/lib/date-format.ts` | a private same-day or "today at" date formatter in a feature file |
| render retrieved evidence as bounded model context                                             | `packEvidenceCards`                                                                                                                                                                                                                                                                                                | `@alfred/assistant/context-search` | hand-joining snippets and citations, or letting a full body or raw bytes reach the model                                                                                    |
| a slot the composition root fills once at boot and a peer reads | `bootPort<T>(label, { missing })` — `install` returns the disposer, `read()` throws on an empty slot; pass `missing` when a caller needs a typed error (a `TriggerConsumerBootError` on a trigger-reachable slot) | `@alfred/assistant/boot-port` | a `let slot: T \| undefined` with its own collide, stale-disposer, and empty-read checks |

## Catalog — canonical owners

The heavy hitters, by owner. Import counts are approximate (from a workspace grep)
and just signal how load-bearing each surface is.

### Value-shape guards — `@alfred/contracts` (`src/guards.ts`)

Validate external / persisted / protocol data instead of asserting it.

- `isRecord`, `isIndexable`, `isNonEmptyString`, `isNonBlankString` (has a non-whitespace character; does not trim)
- `toRecord` (unknown → `Record` or `{}`), `toStringArray` (element-checked)
- `enumGuard(TUPLE)` / `keyGuard(TABLE)` — build an `is*` guard once from its source of truth.
  `enumGuard` takes an `as const` tuple and narrows to `typeof TUPLE[number]`. `keyGuard` takes a
  **closed** table literal and narrows to `` `${Exclude<keyof T, symbol>}` `` (its own string keys;
  `keyGuard(FACT_ONTOLOGY)` → `FactKey`). It reads with `Object.hasOwn`, so `"toString"` and `"__proto__"` are not keys. The
  precondition is the one `typedKeys` has: the runtime keys are exactly the declared keys. Bind
  the result to a `const` after the table; a `const` is not hoisted. The `hand-rolled-key-guard`
  gate catches a hand-written `Object.hasOwn(TABLE, x)` body over a SCREAMING_CASE table only, so
  a lowercase table (`eventPayloadSchemas`, `serverMutators`) and the `x in TABLE` form are
  review-only.
- `toNonEmptyString` (unknown → non-empty string or `undefined`; `""` reads as absent, unlike `getStringPath`), `toFiniteNumber` (unknown → finite number or `undefined`)
- `flattenJson` (`src/flatten-json.ts`): bounded scalar leaves with paths from unknown JSON; used by inbound receipt descriptions.
- `getPath`, `getStringPath`, `getIdPath` (safe nested read; `getIdPath` collapses a string or integer provider id to one string)
- `getStringField(value, key)` — one string property of an error or SDK
  instance, which `getStringPath` rejects because `isRecord` does. Use it in
  place of `isIndexable` + `Reflect.get` + `typeof`.
- `parseEmailAddress` — the address from `parseMailbox`. The address/domain grammar itself is
  a separate leaf, `src/domain.ts`, not `src/guards.ts`: `parseMailbox`, `mailboxLabel`,
  `splitAddressList`, `normalizeEmailAddress`, `emailDomain`, `splitEmail`, `isDomainOrSubdomain`
  (whole-label match; a PROPER subdomain test keeps its bare `endsWith`, as
  `identity-affiliation.ts` does for shared hosting).

`isRecord` answers "is this a plain JSON object?" — a **boundary** question for a value that
arrived as `unknown`: unparsed JSON, a webhook body, a jsonb column with no type claim, a
provider trace. It is **not** a tool to re-open a value a schema already parsed. Applied to a
`z.infer` type, a Drizzle row type, or a locally-authored object it erases the established
shape back to `Record<string, unknown>`, and every field read has to rediscover a type the
parse already proved. If the field you want is typed, index it directly — absence already
shows up as `undefined`.

### Typed keys and records — `@alfred/contracts` (`src/records.ts`)

`Object.keys`, `Object.entries`, and `Object.fromEntries` type every key as `string`. These
helpers hold the one assertion that puts the key union back, so a call site needs none.

- `typedKeys(TABLE)` / `typedEntries(TABLE)` — the keys or `[key, value]` pairs of a **closed**
  object literal (`{ … } as const`, `{ … } satisfies …`), typed by its key union. Precondition:
  the runtime keys are exactly the declared keys. Do not pass a value that came through a
  structural parameter or from outside; read its keys with `Object.keys` and narrow each one.
- `recordFromKeys(KEYS, (key, index) => value)` — a `Record<K, V>` with one entry per key of a
  tuple. The integration projections build on it.
- `pluckField(TABLE, "field")` — one field of each entry of a closed literal, keyed as the
  literal is, each value keeping its own key's type (`OBSERVATION_SOURCE_RANK`,
  `EVENT_TYPES_BY_SOURCE`, `INTEGRATION_ACTIONS`).
- `hasEveryKey(record, KEYS)` — a type guard that closes a `Partial<Record<K, V>>` a loop filled
  one key at a time. It reads keys with `Object.hasOwn`, so a lazy getter does not run.

### Errors — `@alfred/contracts` (`src/errors.ts`)

- `toMessage` (~70 uses — the single most-imported helper)
- `redactSecrets`, `summarizeBody`, `MAX_ERROR_BODY_CHARS`
- `isHttpError`, `httpErrorFromResponse`
- We deliberately do **not** use Effect here — see the shared-error-primitives decision.
  ADR-0114 runs one file on Effect (the MCP connection lifecycle in `manager.ts`), and that
  file throws these same errors. A lint fence keeps `effect` out of every other file.

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
- `INTEGRATION_DISPLAY_NAMES` (in `src/integrations/projections.ts`) — the name every surface uses for a slug,
  indexed with a typed `IntegrationSlug`. `integrationDisplayName(value)` takes an unchecked
  string, asks the registry first, and title-cases only a value that is not a slug.
  `humanizeSlug` takes only a closed literal union: it does not compile for a type that is or
  includes an `IntegrationSlug`, or for an open string type (`string`, `string | "a"`,
  `` `${string}_x` ``). An open string can hold `system`, which is "Alfred" as an integration
  and "System" as anything else, so narrow it to its owning schema's union, or call
  `integrationDisplayName` if it can be a provider. `humanizeSlug(x.provider)` is also a
  consolidation gate, for a closed provider union that holds no registry slug.
- `loopEntityProviderName(provider)` (in `src/loop-key.ts`) — the name of a `LoopEntityProvider`
  (MCP identity provider). Registry slugs read `INTEGRATION_DISPLAY_NAMES`; the rest
  (`clickup` → "ClickUp") read a table next to `LOOP_ENTITY_PROVIDERS`.
- A code with no producer in `src/` fails `packages/contracts/test/app-errors.test.ts`.

### Integration registry — `@alfred/contracts` (`src/integrations/`)

One record per integration (ADR-0093), in four modules: `registry.ts` (the record and its entry
shapes; its keys are the slug space, so `IntegrationSlug` is `keyof` the record), `slugs.ts`
(derived unions and lists), `projections.ts` (slug-keyed tables built from the record), and
`connected.ts` (the executable connected rule each `CredentialSpec` declares). Every
per-integration fact, the tool actions included, is a field on `INTEGRATIONS[slug]`; every table
keyed by an integration is a projection of it or an exhaustive sibling keyed by a union derived
from it. `pnpm check` fails on a `Partial<Record<…Slug, …>>` over a registry union or a literal
`Map` keyed by or valued as one (rule `partial-integration-slug-record`).

- `INTEGRATIONS`, `integrationEntry(slug)` — the record and its typed index:
  `integrationEntry("github").credential.shape` is `"github_app"`.
- `LIVE_PROVIDERS` — the live entries with their slug and credential provider attached, in
  registry order. The one loop the assistant and the web iterate.
- Derived unions (`LiveProviderSlug`, `PlannedSlug`, `CatalogSlug`, `LoadableIntegrationSlug`,
  `BearerSlug`, `TokenPasteSlug`, `GoogleSlug`, `CredentialProvider`, `SupportedPassthroughSlug`,
  `IntegrationBrandKey`) are mapped conditionals over the record, never hand-listed. Where a
  union has a runtime list (`LIVE_PROVIDER_SLUGS`, `CATALOG_SLUGS`, `BEARER_PROVIDER_SLUGS`,
  `CREDENTIAL_PROVIDERS`, …), the list is a `filter` over the tuple and its `is*` guard is an
  `enumGuard` of that list, so the two cannot disagree.
- `INTEGRATION_ACTIONS` — each entry's `actions` tuple under its slug; `ActionSlug` and
  `ToolName` in `src/tools.ts` derive from it.
- `credentialProviderOf(slug)` — the credential provider of a live slug: `google` for a Google
  product, the slug itself otherwise. There is no `provider` field, so a slug cannot be paired
  with another slug's route family.
- `src/google-scopes.ts` — `GOOGLE_SCOPE`, the nine Google scope URLs keyed by product then grant
  (`GOOGLE_SCOPE.gmail.modify`, `GOOGLE_SCOPE.drive.full`); `GOOGLE_SCOPES` and `GoogleScope` derive
  from its leaves; `GOOGLE_FEATURE_SCOPES` groups them by connect feature. Import them from
  `@alfred/contracts`; `@alfred/integrations/google` owns only the OAuth mechanics.
- `src/integrations/google-authority.ts` — `GoogleAuthority` (the slug for a read, `<slug>_<grant>`
  for a named grant, derived from each entry's `credential.grants`) and `googleAuthorityScopes`.
  `GOOGLE_GRANTS_COVERED_BY_CONSENT` fails to compile when an entry's `features` cannot satisfy
  one of its grants.
- `src/oauth-scopes.ts` — `parseOAuthScopeList(scope)`, the one grammar for an OAuth `scope`
  response field. RFC 6749 says space-delimited and Google obeys it; GitHub returns a COMMA list,
  so a whitespace-only split reads `repo,read:org` as one opaque scope and every "already granted?"
  test then answers no forever. Accepts either separator.

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

- `safeJsonParse`, `parseJsonWith` (overloaded: with/without fallback; an `undefined` input returns the fallback, so an optional preview string needs no guard), `toJsonValue`
- `parseJsonText`: `JSON.parse` typed as `JsonValue`; it throws on malformed input, for a caller whose malformed branch differs from `null`

### Sanitize — `@alfred/contracts` (`src/sanitize.ts`)

- `sanitizeToolResult`, `sanitizeErrorMessage`

### Display text — `@alfred/contracts` (`src/text.ts`)

- `collapseWhitespace(text)` — one whitespace fold for every snippet, preview,
  title and summary a person or a model reads. Deliberately not in `sanitize.ts`:
  that module is the ADR-0070 poison boundary, and nothing here protects a sink.
- It is **not** for a value other code compares byte for byte — a key, a hash, a
  dedup token, a cache lookup, or a query a provider must receive unchanged.
  This fold may change whenever a display improves; an identity may not. Being
  stored is not that test, and neither is being read by a classifier: a stored
  summary and a classifier's input snippet are both prose a reader sees.
- It is also not `context-search/pack.ts`'s `oneLine`, which folds only the four
  line terminators so a packed record keeps the provider's own typography.
- Two kinds of exemption, and they are not interchangeable. A site outside
  `packages/assistant/src/knowledge/` carries a per-line `// drift-ok:` reason.
  The three sites inside it are listed in the rule's `owners` array instead,
  because a parallel campaign owns that directory and this campaign may not edit
  it — a whole-file exemption, so a second fold landing in one of those files is
  unrefused until the markers replace it.
- `toDisplayText(value, indent?)` — an `unknown` value as text for a reader: a
  string as it is, anything else as JSON, and a missing value as `null`. `indent`
  pretty-prints the JSON. Use it in place of
  `typeof v === "string" ? v : JSON.stringify(v)`, which `no-runtime-typeof`
  rejects in product source.

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
- **Which zone** (`IanaTimezone`): `settings({ userId }).timezone()`, `firstValidTimezone`,
  `DEFAULT_USER_TIMEZONE`. A `settings` bind loads every preference row of the user
  in one query on its first read, and `.timezone()`, `.flags()`, `.get(key)`, and
  `.all()` on the same bind all read that load. Bind once per request, workflow
  step, or job item and pass the bind down, so a flow that reads the zone and a
  flag costs one SELECT. The load never expires, so never hold a bind at module
  scope (`pnpm check` rejects one) or across a long loop over many users. The bind
  is also the only `user_preferences` reader and writer (`.set`, `.setIfUnset`,
  `.delete`; pass `exec: tx` to stay in a transaction). `pnpm check` rejects a raw
  `userPreferences` query outside `settings/` and the Replicache pull. At a boundary, `parseIanaTimezone` /
  `ianaTimezoneSchema` / `isIanaTimezone` (`@alfred/contracts`).
- **A day key from outside** enters through `parseLocalDateKey` (throws) or
  `isLocalDateKey` (for a Zod `refine` or a filter). Both reject a truncated key
  _and_ a day that doesn't exist — a bare `/^\d{4}-\d{2}-\d{2}$/` accepts
  `"2026-02-30"`, which `Date.UTC` then rolls over in silence.

### DB — `@alfred/db`

- `db`, the schema table objects (`user`, `documents`, `emailTriage`, `agentRuns`,
  `userFacts`, `integrationCredentials`, `apiCallLog`, …), `rowsFromExecute`, `createExecuteRowSchema`
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
- LIKE/ILIKE literals: `escapeLike(value)` (`@alfred/db/helpers`) — escape `\`, `%`
  and `_` in any value that is a literal rather than a pattern. A raw `%` from
  user text or from a key value silently widens the match, which for a key
  lookup means resolving the wrong object.
- Content hash: `sha256Canonical(value)` (`@alfred/db/hash`) — SHA-256 over
  `canonicalJson` (keys sorted, present-`undefined` skipped), prefixed `sha256:`.
  The one digest behind `observations.evidence_hash` (the dedup rail), the
  user-model projection checksum, the artifact base-content token, and the
  workflow revision content hash. A `JSON.stringify` pre-image hashes the same
  logical payload differently per key order, so it cannot be a dedup key; the
  `alfred/sha256-over-json-stringify` lint rule (`scripts/oxlint/alfred/`) bans
  it. Hashing raw text (a webhook body, a document, a key) is a different
  operation: use `sha256Hex(text)` (`@alfred/db/hash`), 64 hex characters with
  no prefix.
- `@alfred/db/hash` is the one module that may export a hash helper. The
  `alfred/no-exported-hasher` lint rule reports a function exported from any
  other module whose parameter flows into a digest, and a re-export of
  `sha256Hex` or `sha256Canonical`. So the sha256 rule can treat every call of
  the two owner helpers as a digest, in any file. A private helper over
  `createHash` (raw key bytes, a trace id) stays legal, because the sha256 rule
  reads its calls in its own file.

### Models — `@alfred/ai`

- `route`

### Web-local — `apps/web/src/lib/`

- `cn` (`utils.ts`), `capitalize`/`lowerFirst` (`strings.ts`),
  `formatDateTime`/`formatRelative` (`date-format.ts`), `formatCost`/`formatTokens` (`usage-format.ts`)

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
The one-line `isValidTimezone` alias that `packages/assistant/src/time/user-timezone.ts`
kept later went too: callers use `isIanaTimezone` directly. Guarded by a `check-consolidation-drift.mjs`
rule that bans a hand-rolled `function isValidTimezone`.

**Resolved:** the Google integration modules had per-file JSON wrappers that only added `.then((raw) => schema.parse(raw))` to `googleJson`. The
schema now goes into the client: `googleJson(service, schema, request)` in
`google/http.ts`, `authedJson(schema, ...)`, and `ProviderClient.json(schema, path)`
parse at the client boundary and return the schema's output type. Do not add a new
per-file wrapper that only binds the service tag. Pass `uncheckedResponse` when a
call only needs success.

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
