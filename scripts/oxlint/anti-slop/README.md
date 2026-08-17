# Vendored anti-slop rules

A partial vendor of [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop),
an Oxlint plugin of rules that reject low-evidence TypeScript. Upstream states it
is "meant to be vendored, not treated as a fixed npm dependency", so this is a
copy we own, not a dependency we track.

- Upstream commit: `446268e5d15baa968eaec669ff65358d36ae6259`
- Upstream license: MIT (see `./LICENSE`; retained because these files are copied,
  not rewritten)
- Plugin API: `@oxlint/plugins`, a root devDependency pinned to the same minor as
  `oxlint` itself. Upstream ships both at one version and the rules import
  `SourceCode` / `Scope` internals, so `oxlint` was moved to `^1.78.0` here to
  match rather than run a 1.77 host against a 1.78 plugin API.

## What is enforced

Three rules, all at `error` in the root `.oxlintrc.json`:

| Rule                   | What it rejects                                             |
| ---------------------- | ----------------------------------------------------------- |
| `no-module-mocking`    | `vi.mock` / `jest.mock` and friends, in favor of real seams |
| `no-reflect-apply`     | `Reflect.apply`, in favor of a typed call                   |
| `no-widen-then-assert` | widening a known value to `unknown` and asserting it back   |

All three had **zero** violations across `apps packages scripts` when adopted, so
each is a pure ratchet — it can only fire on code written after this point. That
is the bar for vendoring a fourth. A rule the tree already violates belongs in
its own change, violations first and the rule second; the alternative is a wave of
disable comments or a warning nobody reads, and `pnpm lint` exits 0 on warnings.

`pnpm check:oxlint-plugin` holds all of that together: it runs the upstream
fixtures, asserts every vendored rule is registered here, and DRIVES each rule
through the root config to prove it reports at `error`. Read the header of
`scripts/check-oxlint-plugin.mjs` for why enablement cannot be read out of
`oxlint --print-config`.

## Why the other twelve rules are not here

Measured against this repo at adoption time, not judged from the README. Counts
are violations in `apps packages scripts`; the split is non-test / test.

**Conflicts with an invariant this repo holds on purpose — do not adopt:**

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

**Reasonable rules whose violations are a paydown, not a config change:**

- `require-safety-comment-for-type-assertion` (604; 304/300) is the closest
  mechanical form of the repo's own "validate at the boundary instead of asserting
  with a cast" directive, and the best candidate to adopt next.
- `no-known-value-widening` (290; 214/76) catches real cases
  (`const SLOT_ORDER: Record<string, number> = { … }` should keep its literal keys
  and use `satisfies`) mixed with a long tail on annotated `return {` that needs a
  read-through before anyone commits to it.
- `no-unsafe-dictionary-type` (155; 90/65) extends the existing
  `Record<string, any>` fence in `.oxlintrc.json` to `Record<string, unknown>`.
- `no-unknown-returns` (102; 90/12), `no-chained-type-assertions` (45; 9/36) and
  `no-runtime-typeof` (370) — the last of which fires on env coercion and on plain
  union discrimination, not only on unparsed input, so it needs scoping before it
  is useful here.
- `no-object-parameters` (3; 1/2) is nearly free but not free: the one non-test
  site, `cleanOutput: object | null` in `packages/assistant/src/execution/executor.ts`,
  is fed by `sanitizeToolResult(...).value as object | null` on its way to a `jsonb`
  column. Typing it honestly means threading the real type through `StepResult`,
  which is a refactor, and the two test sites want `object` for a module namespace
  object.
- `no-shape-in-symbol-names` (170) is a naming rule that reads "shape" as
  structural. Here it is a domain word (`credentialShapeForSlug`,
  `briefing/day-shape`), so the rule is asking for renames that lose meaning.

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
