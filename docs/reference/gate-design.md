# Gate design — which kind of check a rule gets

A rule that only a reviewer enforces is missed the first time the reviewer is tired. A rule that becomes a check is only as good as the instrument it runs on. This doc says which instrument a new rule gets, when an existing gate must move to a stronger one, and what proves a gate is armed. [code-style.md](./code-style.md) tags each checklist rule with the check that enforces it today; the [queue](#queue-review-only-rules-and-the-mechanism-that-would-enforce-them) at the end lists the rules that no check enforces yet.

## The ladder

Take the first rung that can state the rule. Each rung down is weaker: it reads less of the program, so it has more ways to miss a case.

| Rung | Instrument | States | Fails |
| --- | --- | --- | --- |
| 1 | The compiler: types, `tsc` flags | which values a function accepts, which cases a mapping must cover | `pnpm check-types` |
| 2 | Type-aware lint: `typescript/*` in `.oxlintrc.json`, run through tsgolint | a fact that needs the type of an expression but is not a signature | `pnpm lint` |
| 3 | AST rule: `scripts/oxlint/alfred/` | scope, nesting, binding, data flow inside one file | `pnpm lint` |
| 4 | Regex row: `scripts/consolidation-rules.mjs` | one identifier, one call spelling, or one import specifier, on one line | `pnpm check:consolidation` |

A fact that is not about source code goes to a check script instead: a document (`check:pr-body`, `check:plan-status`), a config (`check:oxlint-config`), a manifest or the bundle graph (`check:web-boundaries`, `check:web-bundle-graph`), or reachability (`check:knip`).

### 1. Prefer the compiler

When the rule is about which values a function accepts or which cases a mapping must cover, put it in the types. The compiler reads every call site, through every alias and every rename, so it has no holes for a later PR to close.

The techniques already in the tree:

- **Closed literal union.** A `const` tuple is the source; the type, the `z.enum`, and the membership check derive from it.
- **`satisfies Record<Union, T>`.** A map keyed by the union fails to compile when a member has no entry. `VERDICT_BY_VERCEL_STATE` in `packages/assistant/src/connections/verified-pull/vercel.ts` (#1364) maps every member of `VERCEL_DEPLOYMENT_STATES` to a verdict. A state that the build does not know fails `z.enum(...).safeParse` and becomes an explicit fault, not a default. `NATIVE_STATE_BY_REST_STATUS` in `packages/integrations/src/sentry/issue-read.ts` is the same shape.
- **Closed-domain parameter.** A generic parameter whose type resolves to an uninhabited marker interface when the argument is outside the domain. `humanizeSlug` in `packages/contracts/src/tools.ts` takes `value: S & (...)`: when `S` is or includes an `IntegrationSlug` (#1376), or is an open string type such as `string` or a template pattern (#1383), the intersection names an interface whose one key is the fix and whose value is `never`. No value has that type, so the call fails to compile, and the error text tells the author what to call instead. `OpenStringMember` detects an open string: `{}` is assignable to `Record<S, 1>` only when `S` makes an index signature.
- **Exhaustive switch.** A `default` that assigns the value to `const _exhaustive: never`.

```ts
// The closed-domain shape, reduced. The marker interface is the error message.
interface UseTheRegistryNotThisFunction {
  readonly "Use INTEGRATION_DISPLAY_NAMES[slug]": never;
}
export function format<S extends string>(
  value: S & ([Extract<S, IntegrationSlug>] extends [never] ? unknown : UseTheRegistryNotThisFunction),
): string {
  /* … */
}
```

Why: the regex row `humanize-integration-slug` matched the argument by name. It needed a wider name list (#1369) and optional-chain steps (#1372), and it still could not see `(v) => humanizeSlug(v)`. The compiler guard sees the type whatever the argument is called. The row stays only as a backstop for a closed provider union that holds no registry slug.

When a rule needs the compiler to see across files and a lint rule cannot, close the domain instead: make one module the owner and make every other module unable to reach the primitive. #1385 did this for hashers. `sha256-over-json-stringify` reads one file, so a hash helper imported from another file was out of reach. The fix was not cross-file analysis: `@alfred/db/hash` became the one owner, and `no-exported-hasher` rejects any other exported function whose parameter flows into a digest.

### 2. Then type-aware lint

Use a `typescript/*` rule for a fact that needs types but cannot be a signature: a promise that nobody awaits, an async callback where a void callback is expected, a switch that misses a union member, an object inside a template literal. Four rules are at `error` (#1387); `docs/reference/code-asserts.md` lists them with their options and the queued follow-ups.

The bar is the one the config states: drive the tree to zero, then add the rule at `error`, one rule per change. A rule at `warn` enforces nothing, because `pnpm lint` does not fail on a warning.

### 3. Then an AST rule

Use a rule in `scripts/oxlint/alfred/` for anything about scope, nesting, binding, or data flow: which binding a name resolves to, whether a reference reads or writes, what flows into a call. The plugin's `README.md` gives the layout, the fixture file, and the three steps to register a rule. A rule that replaces a consolidation row keeps that row's file scope through `inGateScope`.

An AST rule also speaks at edit time: `.claude/hooks/lint-on-edit.mjs` lints each file an agent writes.

### 4. Regex only for single-token facts

A row in `scripts/consolidation-rules.mjs` is right when the fact is one identifier, one call spelling, or one import specifier, on one line: `raw-process-env`, `bullmq-job-timestamp`, `as-string-array`. A regex reads text, not code. It cannot tell which binding a name resolves to, it cannot count nesting, and the formatter can split its idiom across lines. A row that needs `scope: "chain"`, a backreference to a binding, or a look-around for an import elsewhere in the file is already describing an AST rule.

A row keeps two strengths that the other rungs do not have: the edit-time hint (`.claude/hooks/helper-hints.mjs` injects its `fix`), and the `hint` severity, which advises without failing while legacy call sites remain.

## Port trigger

**If a regex gate needs a second round of hole fixes, port it to the next rung up. Do not patch it again.**

The first round is normal: the row met the tree. A second round shows that the instrument cannot read the shape, and each later round finds the next spelling that it cannot read.

The evidence, from 2026-10-17 and 2026-10-18:

- `no-function-wrapper-shim` moved to chain scope in #1366, then took hole fixes in #1370, #1374, #1375 (`922c3c3f`, "round 3") and #1377 ("round 4"). The port in #1381 closed the six holes that #1377 left, with scope analysis, and #1382 decided read versus change from the initializer.
- `sha256-over-json-stringify` took hole fixes in #1368, #1371, #1373, #1375 and #1378. #1380 ported it; #1385 then closed the cross-file case by closing the domain (above).
- `no-constants-re-export`, `no-type-re-export-shim` and `no-type-alias-shim` took hole fixes in #1368, #1371, #1372 and #1373. Each one relates an export to an import anywhere in the file, which is a binding question. #1388 ported all three to the `alfred` plugin.

The compiler rules of the same days behaved differently. The `humanizeSlug` guard took two steps: #1376 rejected integration slug types and left plain `string` open, which #1379 patched at runtime; #1383 admitted only closed literal unions and deleted that patch. After #1383 there is no spelling left for a next round to find, because the rule is about the type of the argument, not its text. The exhaustive status maps of #1364 have needed no follow-up.

## A green gate proves nothing about itself

A gate passes on a clean tree whether it is armed or dead. Every new rule ships with a planted-violation probe that asserts the diagnostic text, not the exit code. The lessons behind this are in `.lessons/a-green-lint-run-cannot-tell-an-armed-fence-from-a-dead-one.md`, `.lessons/plant-a-violation-probe-assert-the-diagnostic-not-the-exit-code.md` and `.lessons/equality-probe-fails-open-prove-it-could-have-failed.md`.

What carries the probe on each rung today:

- **Regex row.** The self-test fails `pnpm check` when a `gate` row has no must-catch fixture that names it (#1366).
- **AST rule.** `pnpm check:oxlint-plugin` runs the RuleTester fixtures, then lints each `invalid` case through the root `.oxlintrc.json` and fails unless the rule reports it at `error`.
- **Type-aware rule.** No check drives a planted violation through the `typescript/*` rules. A PR that adds one shows the probe output in its body.
- **Compiler guard.** The guard is the type, and a type that rejects nothing is still green. Prove it once with a call that must fail to compile, run in the PR and reported in its body. `CLAUDE.md` forbids committing it as a `@ts-expect-error` fixture.

A second trap is a gate built on a declared list: it proves the rows someone listed, not the next instance (`.lessons/a-declared-list-gate-cannot-see-the-instance-nobody-declared.md`). Prefer a rule that finds the instance because it was written.

## Queue: review-only rules and the mechanism that would enforce them

Each row is a rule from [code-style.md](./code-style.md) tagged `review` or `partly`, with the rung that would enforce the unchecked part and a rough feasibility. **High**: the rule exists or is small, and the tree is near zero. **Medium**: a paydown or a narrow first-party rule. **Low**: a check cannot separate the good case from the bad one without heavy false positives. **Stays review**: decided, with the reason.

| Rule (code-style section) | Mechanism | Feasibility |
| --- | --- | --- |
| Drop the conditional-spread wrapper (§2 `exactOptionalPropertyTypes`) | Lint: raise `unicorn/no-useless-spread` from the default `warn` to `error` | High |
| No stray `console.log` (§4) | Lint: `no-console` in an `apps/web` override. Two `console.info` sites in `apps/web/src/lib/chat/timing.ts` decide first | High |
| CSS-variable shorthands over arbitrary values (§4) | Lint: `tailwindcss/enforce-canonical`, already in the installed plugin, autofix | High |
| No explicit `any` (§2) | Lint: `typescript/no-explicit-any`. About 12 sites, all a `ZodType` of `any` in `packages/assistant/src/tool-runtime/` | Medium |
| Minimize `!` (§2) | Lint: `typescript/no-non-null-assertion`. A rough grep finds about 14 sites in `src` | Medium |
| Check whether an assertion is needed (§2) | Type-aware: `typescript/no-unnecessary-type-assertion` | Medium |
| Type guards over casts, for the single cast no row reads (§2) | Type-aware: `typescript/no-unsafe-type-assertion`. Expect a large first count | Low |
| Boundary guards stay at the boundary (§2) | Compiler: a closed-domain parameter on `isRecord` / `getPath` that rejects an argument whose type is not `unknown` | Medium |
| Keys are stable IDs (§4) | Lint: `react/no-array-index-key` (add `react` to `plugins`). Seven sites, some of them static skeletons | Medium |
| Effect dependencies (§4) | Lint: `react/exhaustive-deps` | Medium |
| Accessibility (§4) | Lint: the `jsx-a11y` plugin, one rule per change | Medium |
| No N+1 (§3) | AST: a query on a `db()` or transaction handle awaited inside a loop body or an async `.map` | Medium |
| Timeouts and `abortSignal` on external and LLM calls; cancel siblings on failure (§3, hit-lists 3 and 10) | AST: an AI SDK generate or stream call whose options object has no `abortSignal` key | Medium |
| Never log a full error object (§3, hit-list 2) | AST: a `catch` binding passed whole to a logger or `console` call | Medium |
| Never use `updatedAt` as a queue key (§3) | AST: an `updatedAt` column inside an ordering or comparison in a query chain | Medium |
| Do not export a primitive only for a test (§3) | Knip in production mode, where test files are not entries | Medium |
| Bind the credential, not the token, beyond Gmail (§3) | Compiler: client factories that take a credential id and never a token, provider by provider | Medium |
| Webhook signature on the raw body, timing-safe (§3, hit-list 9) | Compiler: the verifier takes a branded raw-body type that only the raw-body reader mints | Medium |
| Self-mirroring oracle (§5) | AST: two calls of one callee inside one `assert.equal`. The regex row is a `hint` that no consumer reads | Medium |
| Existence-only assert; mock `calls.length` alone (§5) | AST: a `test` block whose only assertions are of that kind | Medium |
| Silent `catch` (hit-list 5) | AST: a `catch` that neither rethrows, logs, nor returns a failure value | Low |
| Name the clock of every timestamp (§3) | Compiler: brand each clock. A wide migration for a rare bug | Low |
| Literal pin needs a `why` (§5) | AST cannot tell a policy literal from a change detector | Low |
| Derive row, schema and cross-package types (§1, hit-list 1) | `code-asserts.md` explains why a checker cannot separate a reshape from drift; `pnpm schemas:dupes` stays a discovery aid | Stays review |
| A `SAFETY:` note in a test (§1 Suppressions) | An ordinary comment, not a directive, so the unused-directive check has nothing to read | Stays review |
| Name symbols for their domain role (§2) | A substring ban cannot tell the `credential` field from `DayShape` (#1149) | Stays review |
| Constants: name them, place them at the narrowest owner (§2) | A literal ban fires on transparent arithmetic (`code-asserts.md`) | Stays review |
| Choose `k?: T` or `k?: T \| undefined` (§2) | The choice depends on what every consumer does with absence | Stays review |
| Transactions, idempotency, pagination, route auth (§3, hit-list 4) | Each needs knowledge of intent that the code does not state | Stays review |
| Never `db:push` outside local exploration (§3) | A command someone runs, not a fact in the source | Stays review |
| One return value per state; a status map exists at all (§3) | The compiler holds a map once it is written; deciding that one is needed is design | Stays review |
| Scripts call the live owner (§3, hit-list 14) | A copy compiles; `no-restricted-imports` already fences the `internal` doors | Stays review |
| Render every state; SSR-safe; effect cleanup (§4, hit-list 8) | Behaviour, not shape | Stays review |
| Duplicated logic that co-changes (hit-list 6) | `check:duplicates` finds copies; whether they co-change is judgment | Stays review |
| Check an issue's premise against data (hit-list 13) | Not a code fact | Stays review |
