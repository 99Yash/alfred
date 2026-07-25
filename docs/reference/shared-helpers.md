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

`pnpm dup` (jscpd) remains the *cure* layer for copy-pasted bodies after the
fact. When a helper here has exactly one owner, a re-implementation of it is a
candidate `gate` rule — see [Closing the loop](#closing-the-loop).

## Smell map — when you're about to…, reach for

| You're about to write… | Reach for | From | Don't hand-roll |
|---|---|---|---|
| a check that an `unknown` is a non-null object before indexing it | `isRecord(x)` / `toRecord(x)` | `@alfred/contracts` | `typeof x === "object" && x !== null` |
| coerce `unknown` into a `string[]` | `toStringArray(x)` | `@alfred/contracts` | `x as string[]` — **the drift check bans this** |
| read a nested field off `unknown`/parsed JSON | `getPath` / `getStringPath` | `@alfred/contracts` | chained `?.` with casts |
| check a value is a present, non-empty string | `isNonEmptyString(x)` | `@alfred/contracts` | `typeof x === "string" && x.length` |
| turn a caught error into a display string | `toMessage(err)` | `@alfred/contracts` | `String(err)` / `err.message` |
| redact secrets from an error/body before logging | `redactSecrets` / `summarizeBody` | `@alfred/contracts` | ad-hoc regex |
| parse **and** validate a JSON string | `parseJsonWith(raw, schema, fallback?)` | `@alfred/contracts` | `JSON.parse(...)` then a cast |
| parse JSON that might be malformed, no schema | `safeJsonParse(raw)` | `@alfred/contracts` | `try { JSON.parse } catch` |
| normalize / extract an email address | `parseEmailAddress(value)` | `@alfred/contracts` | manual `<...>` / lowercase parsing |
| fold a key to a canonical form | `canonicalParamKey(key)` | `@alfred/contracts` | `.toLowerCase().replace(/[_-]/g, "")` — **drift check bans the raw idiom** |
| strip tool-result / error noise before it hits a model | `sanitizeToolResult` / `sanitizeErrorMessage` | `@alfred/contracts` | inline trimming |
| enforce Alfred's prose voice (no em-dashes, plain words) | `sanitizeVoice` / `createVoiceStreamSanitizer` | `@alfred/api` agent voice-sanitize | manual string replaces |
| read an environment variable | `serverEnv()` | `@alfred/env/server` | `process.env.*` — **repo invariant** |
| validate a timezone string | `isIanaTimezone(value)` | `@alfred/contracts` | `function isValidTimezone` / a raw `Intl.DateTimeFormat` trial — **drift check bans it** |
| resolve a user's timezone / format an instant in it | `resolveUserTimezone` / `formatInstantInTimezone` | `@alfred/api` timezone module | `Intl` glue per call site |
| get a language-model handle | `getChatModel` / `getCheapModel` | `@alfred/ai` | constructing a provider client |
| run a query and read typed rows | `rowsFromExecute` + named Drizzle row types | `@alfred/db` | `(res as Row[])` |
| merge Tailwind class names (web) | `cn(...)` | `apps/web/src/lib/utils.ts` | template-string concatenation |
| capitalize / lower-first / relative-time a string (web) | `capitalize` / `lowerFirst` / `formatRelative` | `apps/web/src/lib/strings.ts` | inline `slice(0,1).toUpperCase()` |

## Catalog — canonical owners

The heavy hitters, by owner. Import counts are approximate (from a workspace grep)
and just signal how load-bearing each surface is.

### Value-shape guards — `@alfred/contracts` (`src/guards.ts`)
Validate external / persisted / protocol data instead of asserting it.
- `isRecord`, `isPlainRecord`, `isIndexable`, `isNonEmptyString`
- `toRecord` (unknown → `Record` or `{}`), `toStringArray` (element-checked)
- `getPath`, `getStringPath` (safe nested read)
- `parseEmailAddress`

### Errors — `@alfred/contracts` (`src/errors.ts`)
- `toMessage` (~70 uses — the single most-imported helper)
- `redactSecrets`, `summarizeBody`, `MAX_ERROR_BODY_CHARS`
- `isHttpError`, `httpErrorFromResponse`
- We deliberately do **not** use Effect here — see the shared-error-primitives decision.

### JSON — `@alfred/contracts` (`src/json.ts`)
- `safeJsonParse`, `parseJsonWith` (overloaded: with/without fallback), `toJsonValue`

### Sanitize — `@alfred/contracts` (`src/sanitize.ts`)
- `sanitizeToolResult`, `sanitizeErrorMessage`

### Env — `@alfred/env/server`
- `serverEnv()` — the only sanctioned reader of process env.

### Timezone — `@alfred/api` (`src/modules/timezone/`)
- `resolveUserTimezone`, `firstValidTimezone`, `localStartOfDay`,
  `localTimeInTimezone`, `addLocalDays`, `formatInstantInTimezone`,
  `DEFAULT_USER_TIMEZONE`

### DB — `@alfred/db`
- `db`, the schema table objects (`user`, `documents`, `emailTriage`, `agentRuns`,
  `userFacts`, `integrationCredentials`, `apiCallLog`, …), `rowsFromExecute`
- Lifecycle: `closeConnections`, `warmPool`, `closeRedis`; type `DbTransaction`

### Models — `@alfred/ai`
- `getChatModel`, `getCheapModel`

### Web-local — `apps/web/src/lib/`
- `cn` (`utils.ts`), `capitalize`/`lowerFirst`/`formatRelative` (`strings.ts`),
  `formatCost`/`formatTokens` (`usage-format.ts`), `asRecord`/`parseJsonRecord`
  (`json-record.ts` — prefer the contracts guards for anything reusable)

## Where new helpers go (colocation rule)

1. **Cross-boundary and browser-safe** (used by web *and* server, no Node deps) →
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
`packages/api/src/modules/briefing/preferences.ts`). All three now route through
the pre-existing, better `isIanaTimezone` in `@alfred/contracts` (memoized +
alias-aware; a bare `Intl.DateTimeFormat` trial once broke briefings on `"UTC"`).
The api keeps `isValidTimezone` as a one-line alias of `isIanaTimezone` so its
call sites read in domain terms. Guarded by a `check-consolidation-drift.mjs`
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
