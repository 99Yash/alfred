# Code asserts — what can be a lint and what stays a checklist

The rules in `code-style.md` span mechanical checks (`pnpm check` fails) and
review judgment. This file maps each assert to its enforcement so you know
where to put a new invariant.

## Lint-ratcheted (fails `pnpm check`)

| Assert | Rule | Where it lives |
| --- | --- | --- |
| `Record<string, any>` defeats `unknown` guards | `typescript/no-restricted-types` | `.oxlintrc.json:typescript/no-restricted-types` |
| `Record<string, unknown>` as open dict without contract | `anti-slop/no-unsafe-dictionary-type` (`error`) | `scripts/oxlint/anti-slop/` |
| Widening a known literal to `Record`/`unknown` | `anti-slop/no-known-value-widening` (`error`) |
| Widen then assert back (`unknown` → `as T`) | `anti-slop/no-widen-then-assert` (`error`) |
| Chained `as` / angle-bracket asserts | `anti-slop/no-chained-type-assertions` (`error`) |
| `unknown` in a type alias that leaks to callers | `anti-slop/no-unknown-type-aliases` (`error`), `no-unknown-returns` (`error`) |
| `typeof` over unparsed wire values instead of boundary parse | `anti-slop/no-runtime-typeof` (`error`) |
| Type assertions: check first whether the assertion is needed at all | review judgment (see `code-style.md` — the `require-safety-comment-for-type-assertion` rule was removed after measuring 281/281 violations under the test/eval exemption and 0 in product source) |
| `vi.mock`/`jest.mock` | `anti-slop/no-module-mocking` (`error`) |
| `Record<string, any>` already covered | `typescript/no-restricted-types` |
| `process.env.*` outside `serverEnv()` | `scripts/consolidation-rules.mjs` `gate: no-process-env` |
| Spreading overrides over defaults | `gate: spread-over-defaults` (`withDefaults`) |
| An exported function that only returns a constant or an imported name (a second door) | `alfred/no-function-wrapper-shim` (`error`), first-party, scope-aware | `scripts/oxlint/alfred/` |
| A logic file that hands out a value of a `constants` module again (`export { X }`, `export * from`, `export default X`, a `const` alias), when it is not the package barrel (a second door) | `alfred/no-constants-re-export` (`error`), first-party, scope-aware | `scripts/oxlint/alfred/` |
| The same for a type of a `constants` module (`export type { … }`, `export { type X }`, `export type * from`) | `alfred/no-type-re-export-shim` (`error`), first-party, scope-aware | `scripts/oxlint/alfred/` |
| An exported type that is only a new name for an imported type (`export type X = Y`, `export interface X extends Y {}`) | `alfred/no-type-alias-shim` (`error`), first-party, scope-aware | `scripts/oxlint/alfred/` |
| Duplicate helper bodies | `pnpm dup` (jscpd) — cure, not prevention |
| A suppression that suppresses nothing (`eslint-disable` / `oxlint-disable` naming a rule that did not fire) | `oxlint --report-unused-disable-directives-severity=error`, wired into the root `lint` script |
| A rule turned `"off"` for authored source with no stated reason | `scripts/oxlint-config.mjs` `blanketDisarmFailures` (via `check:oxlint-config`) |
| A promise nobody awaits, catches, or marks with `void` | `typescript/no-floating-promises` (`error`, type-aware) | `.oxlintrc.json` |
| An async function where a void callback is expected (`onClick={async …}`, `.finally(async …)`), or a promise in a condition or spread | `typescript/no-misused-promises` (`error`, type-aware) | `.oxlintrc.json` |
| A switch over a union that misses a member, with or without a `default` | `typescript/switch-exhaustiveness-check` (`error`, type-aware) | `.oxlintrc.json` |
| A template literal that interpolates an object, `unknown`, or `never` | `typescript/restrict-template-expressions` (`error`, type-aware) | `.oxlintrc.json` |
| An `any` that flows into a return, an argument, a call, a member read, or an assignment in TypeScript source | `typescript/no-unsafe-return`, `-argument`, `-call`, `-member-access`, `-assignment` (`error`, type-aware; off for `.mjs`/`.js`/`.cjs`) | `.oxlintrc.json` |
| An `await` of a non-thenable, `delete` on an array element, `for…in` over an array, a string passed as code to `setTimeout` / `new Function`, unary minus on a non-number, or a default value that can never apply | `typescript/await-thenable`, `no-array-delete`, `no-for-in-array`, `no-implied-eval`, `no-unsafe-unary-minus`, `no-useless-default-assignment` (`error`, type-aware) | `.oxlintrc.json` |
| A value imported only for a type position, such as `typeof` | `typescript/consistent-type-imports` (`error`) | `.oxlintrc.json` |
| A suppression directive with no rule name, or no reason after ` -- ` | `gate: suppression-without-reason` | `scripts/consolidation-rules.mjs` |
| A spread that only copies, such as `{ ...(x ? { k: x } : {}) }` alone in a literal | `unicorn/no-useless-spread` (`error`) | `.oxlintrc.json` |
| A `console` call other than `error` / `warn` in the web app | `no-console` (`error`, `apps/web/src/**` override) | `.oxlintrc.json` |
| A Tailwind arbitrary value or variable that has a canonical class with the same CSS | `tailwindcss/enforce-canonical` (`error`) | `.oxlintrc.json` |

### The two config-hygiene rules, and why they are separate from the `anti-slop` set

Both live in `scripts/oxlint-config.mjs` rather than in `scripts/oxlint/anti-slop/`,
because their subject is the CONFIG, not the source: one asks which files the linter
opens and which suppressions they carry, the other asks whether a fence is armed.

**Unused suppressions.** A `// eslint-disable-next-line <rule>` for a rule that no
longer fires is a comment that reads like an exemption and is not one, and it is
invisible to a plain lint run: the run is green either way. Measured when this row was
added: **53** across the tree, of which 40 named
`anti-slop/require-safety-comment-for-type-assertion` inside test scopes where that rule
is `"off"` — so they could not have suppressed anything. Two more were load-bearing:
`packages/assistant/src/execution/service.ts` hid a bare `type AgentTx = any` (which
`CLAUDE.md` forbids) behind a directive for a rule absent from the config, and the
`any` was hiding a write that did not match `AgentError`. The tree was driven to zero
and the flag is at `error`.

The rule name is the whole mechanism, so a rule that stops applying leaves its
suppressions behind silently. Deleting one is the fix; keeping one "in case the rule
comes back" is what produces the next 53.

**Blanket disarms.** An `overrides` entry REPLACES a rule's options wholesale, so
`"off"` is scoped to the RULE, not to any one pattern inside it — the shape in
`.lessons/an-off-in-a-lint-override-disarms-every-pattern-the-rule-carries.md`. For a
single-rule `anti-slop` override there are no groups to restate, so the cure that
lesson gives does not apply and the exemption is invisible instead. The rule requires a
`// oxlint-disarm: <rule> — <why>` comment beside the key, and skips test/eval
scopes, where a blanket `"off"` is the deliberate and correct choice. The two
ops-scripts trees (`apps/server/src/scripts`, `packages/*/src/scripts`) carry
their own disarm markers, and repo-level `scripts/` gates carry per-site
disables instead of any glob.

It deliberately does **not** report a scope for naming many individual files. The lists
in this config are heterogeneous by design — a boundary parser, a provider client, a
BullMQ processor and a framework seam are all honest `unknown` returns, and no path glob
covers them without exempting every unrelated module beside them. A curated allowlist
is the right shape; what it needs is a stated reason, not a shorter list.

`no-restricted-imports` is excluded from this rule because it is the one rule here
carrying several independent groups, and `restrictedGroupCopyFailures` already demands
a restated copy or a declared omission per group.

### Type-aware rules

`.oxlintrc.json` sets `options.typeAware`, so every oxlint run (`pnpm lint`,
the edit-time hook, the `check:oxlint-config` probe) also runs the rules that
need type information, through the `oxlint-tsgolint` root devDependency. A
missing tsgolint binary fails the run instead of skipping the rules. Fifteen
rules are at `error`, each adopted at zero:

- `typescript/no-floating-promises`, with the `node:test` registrars
  (`describe`, `it`, `suite`, `test`) as known-safe calls, because the runner
  owns the promise they return.
- `typescript/no-misused-promises`, default options. Mark a deliberate
  fire-and-forget with `() => void run()`, the pattern the web app already
  uses. A script's cleanup goes in a top-level `try` / `finally`, not in
  `.finally(async …)`.
- `typescript/switch-exhaustiveness-check`, default options. A `default` does
  not stand in for a missing member (`considerDefaultExhaustiveForUnions` is
  off), so a union switch names every member and ends in the
  `const _exhaustive: never` default. A `default` is still allowed after every
  member, which that check needs. A switch over an open `string` needs no
  `default`. A switch over the ESTree node union in `scripts/oxlint/` carries
  its own directive with the reason.
- `typescript/restrict-template-expressions`, default options. For a value
  the compiler types as `never` in an exhaustive `default`, print it with
  `String(value)`.
- The `no-unsafe-*` family, default options: `typescript/no-unsafe-return`,
  `no-unsafe-argument`, `no-unsafe-call`, `no-unsafe-member-access` and
  `no-unsafe-assignment`. An `any` may not flow into a return, an argument, a
  call, a member read, or an assignment. Bind a value that a library or the
  standard library types as `any` (`res.json()`, `JSON.parse`, `Reflect.get`,
  `signal.reason`, a computed `import()`) to `unknown` and narrow or parse it
  at the boundary. A `.map` callback over SDK values declares its return type,
  so an `any` field lands in a schema's `unknown` slot. `Array.isArray` on a
  `ReadonlyArray` or on `JsonValue` narrows each element to `any`: iterate the
  typed array, or use a guard that returns `readonly T[]`. JSON text becomes a
  `JsonValue` through `parseJsonText` / `safeJsonParse`, which own the one
  `JSON.parse` the family suppresses. The rules are off for `.mjs`, `.js` and
  `.cjs` (the last `overrides` entry), where JSDoc-typed code runs with
  `noImplicitAny` off and `any` is the default type.
- Six rules from oxlint's default `correctness` set, default options, adopted
  with zero hits in TypeScript and JavaScript sources:
  `typescript/await-thenable` (an `await` of a value that is not a thenable),
  `no-array-delete` (`delete` on an array element), `no-for-in-array`
  (`for…in` over an array), `no-implied-eval` (a string passed to
  `setTimeout`, `setInterval` or `new Function`), `no-unsafe-unary-minus`
  (unary minus on a value that is not a `number` or `bigint`) and
  `no-useless-default-assignment` (a default value for a binding whose type
  does not include `undefined`). They apply to `.mjs`, `.js` and `.cjs` too.

The rules read a test or eval file through its package's `tsconfig.test.json`
or `tsconfig.eval.json`: the root `tsconfig.json` is a solution file that
references them, so the TypeScript project service finds the program that a
package's `src`-only `tsconfig.json` does not contain. A file that a
`tsconfig.test.json` excludes (the typecheck baseline) has compiler errors, and
the rules report the error types as unsafe. Those files carry a directive that
names the baseline. Remove the directive with the baseline entry; the unused-
directive check reports it if it outlives the errors.

Turning type-aware on also arms the type-aware rules in oxlint's default
`correctness` set at `warn`. The config sets each of them explicitly, so the run
reports only the rules it chose: the six above at `error`, and the seven that
still have hits on the tree `"off"` (`no-base-to-string`,
`no-duplicate-type-constituents`, `no-meaningless-void-operator`,
`no-misused-spread`, `no-redundant-type-constituents`,
`require-array-sort-compare` and `unbound-method`). The queued follow-ups are
those seven and `no-unnecessary-condition`. Each lands alone in its own change:
drive the tree to zero, then set the rule to `error`.

These are the cheap place for a new invariant **if it can be phrased as a
syntax shape**. The vendored `anti-slop` set is deliberately small; a new
rule is added only after its violations are driven to zero at `warn` first
(`README` in `scripts/oxlint/anti-slop/`). Prefer a `hint` → `gate` promotion
over a permanently noisy `warn`.

A first-party rule that needs the syntax tree or scope analysis (where a name
is bound, whether a reference reads or writes) goes in `scripts/oxlint/alfred/`
instead of a regex row in `scripts/consolidation-rules.mjs`. See the `README`
there. `pnpm check:oxlint-plugin` drives the rules of both plugins.

## Review / compile-time pinned (no lint, but checkable)

| Assert | Why lint is a poor fit | How we pin it |
| --- | --- | --- |
| Derive row types from `$inferSelect` / `$inferInsert`, not hand-rolled `interface` | Correct derive depends on `Pick`/`Omit` shape equality and on trick columns (`jsonb`→`unknown`, `numeric`→`string`, `.$type<Brand>()`); a generic "hand-rolled equals infer" checker cannot separate intentional reshapes (`Synced*`) from drift | `tsc` + named row-type exports (`Document`, `NewArtifact`); review hit-list `code-style.md:1` |
| One owning schema per contract — consumers `pick`/`omit`/`extend`/`satisfies z.ZodType<>` | Placement is ownership-by-role, not file type (`schemas.md: placement follows consumer need` — `contracts` for browser+server, `@alfred/sync` for Replicache, provider client for wire, colocate only for one-feature/one-payload). Per-package `schemas/` directories are rejected (`code-style.md: Rejected: per-package schemas/` + `research/schema-and-const-homes-2026-08-22.md`): they concentrate files, not complexity, and a generic `schemas.ts` gate would miss the seam | `pnpm schemas --dupes` discovery aid + `satisfies z.ZodType<>` / `z.infer` return-type compile pins (`readIntegrationStatus`); `code-style.md:1` |
| `isRecord`/`getPath` only at true `unknown` boundaries — not on already-typed/SDK values | The guard's *name* is the same on both sides; lint would have to know whether the input was genuinely `unknown` vs `z.infer`/row/SDK type, which is a type-flow question | Review + `anti-slop` ratchets above (unsafe-dict / known-value-widening / widen-then-assert fire downstream of a misplaced `isRecord`); `contracts/AGENTS.md: isRecord is a boundary guard` + `ai/AGENTS.md: SDK objects, not JSON records` |
| Constants at narrowest stable owner — `@alfred/contracts` only for cross-boundary (wire limits, synced enums, `contracts`-visible caps), else owning package/module, `env` only for deploy knobs | `42` vs `EMPTY_COMPLETION_MAX_RETRIES = 42` is context-dependent; a literal ban fires on transparent arithmetic and forces false abstractions | Review per `code-style.md: Constants and configuration ownership` |
| A dedicated `constants.ts` / `config.ts` earns its place only when values couple (several derived expressions depend on one knob, e.g. `packages/env/src/pool.ts: derivePoolMax()` from `AGENT_WORKER_CONCURRENCY_DEFAULT`) — proximity alone does not justify one; an uncoupled grab-bag fails the deletion test | A file-exists gate would force a `constants.ts` per package and hide the coupling test | Review + `code-style.md: A dedicated constants file earns its place only when values couple` |
| Zod schemas vs hand-rolled `interface` drift — `z.infer` is source, not parallel | An `interface` that merely overlaps a schema today should evolve independently only when intentional (`Synced*` reshapes); otherwise `Pick`/`z.infer` keeps them in sync | `code-style.md: Never hand-roll a type that already exists` |
| PR body carries the four sections `CLAUDE.md` names | The subject is a document, not source, so a syntax rule cannot see it — but it IS mechanically checkable, which is why it is a check and not a review item | `scripts/check-pr-body.mjs` (CI step; fails closed) |
| A suppression names the rule it suppresses, in the rule's own spelling | `oxlint` already answers "did this directive suppress anything", so there is nothing for a reviewer to add | `--report-unused-disable-directives-severity=error` in the root `lint`; see the section above |

Add a new row here when you touch `code-style.md` so the next reader knows
whether to write a rule or a checklist bullet.
