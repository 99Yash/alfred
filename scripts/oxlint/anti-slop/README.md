# Vendored anti-slop rules

A partial vendor of [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop),
an Oxlint plugin of rules that reject low-evidence TypeScript. Upstream states it
is "meant to be vendored, not treated as a fixed npm dependency", so this is a
copy we own, not a dependency we track.

- Upstream commits: `446268e5d15baa968eaec669ff65358d36ae6259` for every rule except
  `require-readable-spacing`, and `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` for
  `require-readable-spacing.ts` plus its vendored `vendor/eslint-stylistic/`
  dependency. The second revision also carries upstream fixes to rules we keep at
  the first; porting those is a separate change, not part of this one.
- Two rules were ported forward to `f2a8e0b9a479f3c7fa75d64ab7341add40eab7e1`
  ("fix: refine third-party and boundary conventions"): `no-shape-in-symbol-names.ts`
  gained `isBorrowedMemberName` (a static member read such as Zod's `schema.shape`
  belongs to its owner and cannot be renamed locally) and `no-runtime-typeof.ts`
  gained `isExistenceProbe` (`typeof x === "undefined"` establishes whether a
  binding exists rather than narrowing its representation). Their fixtures were
  re-copied from the same revision.
- Upstream license: MIT (see `./LICENSE`; retained because these files are copied,
  not rewritten). `vendor/eslint-stylistic/` carries its own `LICENSE` and
  `UPSTREAM.md` provenance, because the padding rule is vendored from ESLint
  Stylistic rather than written by anti-slop.
- The vendored directory is excluded from `pnpm lint` via `ignorePatterns` in the
  root `.oxlintrc.json`. We copy the rules verbatim so future upstream diffs stay
  reviewable; the plugin is proven by `pnpm check:oxlint-plugin`'s fixtures and
  root-config drive, not by linting its own source.
- Plugin API: `@oxlint/plugins`, a root devDependency pinned to the same minor as
  `oxlint` itself. Upstream ships both at one version and the rules import
  `SourceCode` / `Scope` internals, so `oxlint` was moved to `^1.78.0` here to
  match rather than run a 1.77 host against a 1.78 plugin API.

## What is enforced

**Eight rules at `error`** — ratchets with zero violations in the tree:

| Rule                         | What it rejects                                                         |
| ---------------------------- | ----------------------------------------------------------------------- |
| `no-module-mocking`          | `vi.mock` / `jest.mock` and friends, in favor of real seams             |
| `no-reflect-apply`           | `Reflect.apply`, in favor of a typed call                               |
| `no-widen-then-assert`       | widening a known value to `unknown` and asserting it back               |
| `no-object-parameters`       | `object` type on function inputs                                        |
| `no-chained-type-assertions` | nested `as` / angle-bracket assertions                                  |
| `no-known-value-widening`    | broadening known literal types to `Record<string, T>`                   |
| `no-unknown-type-aliases`    | type aliases that resolve to `unknown`                                  |
| `require-readable-spacing`   | missing blank lines between declarations and statement groups (autofix) |

All but `require-readable-spacing` were adopted at warn with violations and driven
to zero before promotion (`no-chained-type-assertions`: 46 → 0;
`no-known-value-widening`: 290 → 0; `no-unknown-type-aliases` was clean on arrival
and never had any).

`require-readable-spacing` is the one autofix rule. It was adopted by running
`pnpm exec oxlint --config .oxlintrc.json --fix .`, which inserted blank lines
only — 17,337 lines across 1,301 files — and changed nothing else. Its policy is
upstream's: a blank line after the import block, between top-level declarations,
around multiline bindings and block-like statements, and before
`return`/`if`/`switch`/`try`/`for`/`while`/`do`. It never removes a blank line and
takes no options; the vendored source is the policy. The padding engine is the
ESLint Stylistic `padding-line-between-statements` rule, vendored under
`vendor/eslint-stylistic/` with its own license and provenance.

**Five rules at `warn`** — paydown rules with live violations (counts as of
2026-08-26):

| Rule                                        | Violations | What it rejects                                     |
| ------------------------------------------- | ---------- | --------------------------------------------------- |
| `no-runtime-typeof`                         | ~405       | runtime `typeof` checks instead of boundary parsing |
| `require-safety-comment-for-type-assertion` | ~220       | type assertions without a `SAFETY:` comment         |
| `no-shape-in-symbol-names`                  | ~170       | "shape" in identifier names                         |
| `no-unsafe-dictionary-type`                 | ~155       | `Record<string, unknown>` and equivalents           |
| `no-unknown-returns`                        | ~94        | functions returning `unknown`                       |

`no-runtime-typeof` runs with `{ "allowInTypeGuards": true }` (see
`.oxlintrc.json`), so a `typeof` check inside a `value is T` predicate does not
report. Counts drift with paydown; regenerate with
`pnpm exec oxlint --format json . | grep -o 'anti-slop([^)]*)' | sort | uniq -c`.

`pnpm check:oxlint-plugin` holds all of that together: it runs the upstream
fixtures, asserts every vendored rule is registered here, and DRIVES each rule
through the root config to prove it reports at its expected severity. Read the
header of `scripts/check-oxlint-plugin.mjs` for why enablement cannot be read
out of `oxlint --print-config`.

## Why some rules are not here

Three upstream rules conflict with invariants this repo holds on purpose:

- `no-conditional-empty-object-spread` (257) rejects `...(x ? { x } : {})`. That is
  the idiom `exactOptionalPropertyTypes: true`
  (`packages/config/tsconfig.base.json`) requires in order to omit an optional
  property rather than set it to `undefined`. The rule would trade a working
  invariant for a stylistic one.
- `no-unknown-parameters` (394) rejects `unknown` inputs. It therefore rejects the
  signature of every boundary validator the root `CLAUDE.md` mandates — a parser
  whose input is already typed has nothing left to prove. `isPassthroughPreferenceOn(value: unknown)`
  is the rule working exactly as designed and the repo being right anyway.
- `no-reflect-get` (15) rejects `Reflect.get`. Every site here is
  `isIndexable(value)` followed by a field read off a **class instance** — a caught
  `Error`, a node-postgres `DatabaseError`, a Drizzle `DrizzleQueryError`. The
  suggested replacement, `getPath`, is built on `isRecord`, which rejects anything
  whose prototype is not `Object.prototype`, so it returns `undefined` for all of
  them. `packages/contracts/CLAUDE.md` documents the `isIndexable` + `Reflect.get`
  pair as the correct answer to this exact question.

Two newer upstream rules are simply not adopted yet, not rejected on conflict:
`no-array-filter-map` and `no-reduce-accumulator-copy`. Both are performance rules
with their own adoption bar, and neither was pulled in with the spacing rule.

## Updating from upstream

The vendor is a copy, so `pnpm format` owns its formatting and diffs against
upstream will show whitespace. To pull a fix: re-copy the specific
`rules/<name>.ts`, its fixtures and any `shared/` module it imports; update the
commit SHA above; run `pnpm check:oxlint-plugin`. Do not vendor a rule without its
fixtures — the gate rejects that, because a rule that silently stops matching
leaves a green tree behind it.

Upstream's `<rule>.test.ts` is renamed to `<rule>.rule-test.ts` on the way in.
`*.test.ts` is a load-bearing name here: `isScanFile` in
`scripts/test-id-prefixes.mjs` claims every `*.test.ts` wherever it lives for the
DB test-id census, whose walk covers only `packages` and `apps`, so the upstream
name put these files inside a scan surface and outside its walk. That check's
self-test caught it. These are fixtures this gate runs, not a suite a workspace
runner owns.
