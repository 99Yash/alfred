# Alfred oxlint rules

Alfred's own oxlint JS plugin. These rules are first-party source: we write and
own them. That is the difference from `../anti-slop/`, which is a vendored copy
of a third-party plugin that we keep close to upstream.

So this directory is linted like any other repo source. It is not in
`ignorePatterns` in the root `.oxlintrc.json`, and the anti-slop rules apply to
it. `scripts/tsconfig.json` type-checks it, and `pnpm check-types` runs that
program.

## What belongs here

A rule belongs here when it needs the syntax tree or scope analysis: where a
name is bound, how deep a type nests, whether a reference reads or writes. A
fact that a regex over source text can state belongs in the table in
`scripts/consolidation-rules.mjs`, which `pnpm check:consolidation` runs and the
edit-time hook `.claude/hooks/helper-hints.mjs` reads. A rule moves here when
its regex holes are the kind a regex cannot close.

`helper-hints.mjs` does not read this plugin. A second edit-time hook does:
`.claude/hooks/lint-on-edit.mjs` runs after each `Edit`, `Write` or `MultiEdit`
of a `.ts`/`.tsx` file, lints that one file with the root `.oxlintrc.json`, and
gives the agent every diagnostic it finds. So a rule registered here speaks
while an agent writes the file, with no table to update. The hook is advisory:
it cannot block the write, and `pnpm lint` stays the gate. Both hooks are
registered in the tracked `.claude/settings.json`. Claude Code asks each user to
trust project hooks before it runs them, and asks again when they change.

## Layout

- `index.ts` builds the plugin with `eslintCompatPlugin` from `@oxlint/plugins`
  and `meta: { name: "alfred" }`. It imports each rule from
  `./rules/<rule-id>.ts`. Keep the `rules` object sorted by key, one
  `"<rule-id>": <name>Rule,` entry per line: `pnpm check:oxlint-plugin` reads
  that shape.
- `rules/<rule-id>.ts` is the rule. Its doc comment is the spec: what it flags,
  what it skips, and why.
- `rules/<rule-id>.rule-test.ts` is the RuleTester fixture file. The name is not
  `*.test.ts` on purpose (see the header of `scripts/check-oxlint-plugin.mjs`).
- `shared/` holds AST helpers only when a second rule needs them. Do not import
  from `../anti-slop/`: it is vendored, so copy a small helper instead.
- A rule that replaces a consolidation gate keeps that gate's file scope by
  returning `inGateScope(context.filename, context.cwd)` from `before()`
  (`shared/scope.ts`). It reads `isSkippedPath`, so the scope cannot drift from
  the table, and the rule needs no `overrides` entry in `.oxlintrc.json`. A
  gate that also had per-rule `owners` keeps them as a closed `OWNERS` set in
  the rule's own source, each with its reason, and returns
  `inGateScopeExcept(context.filename, context.cwd, OWNERS)` instead. An owner
  is skipped whole, as the gate skipped it.
- `shared/module-bindings.ts` resolves a module-level name to the import or
  module `const` that binds it, through the scope manager.
  `no-constants-re-export` and `no-type-re-export-shim` read one list from it
  (`constantsReExports`) and each reports its own kind, value or type, so a
  re-export is reported once and the two rules cannot disagree on what a
  `constants` module is. `no-type-alias-shim` reads its import resolution.
- `shared/class-tokens.ts` reads the Tailwind class tokens of one element:
  a `className` attribute or a `cn(…)` call, through branches, nested
  joiners and same-file `const` names. `transition-names-individual-transform`,
  `no-delta-class-utility-collision` and `motion-safe-variant-animate` read
  one element's classes from it, so the three rules agree on what "one
  element" is.
- `shared/digest-flow.ts` is the value flow into a hash digest (sinks, reaching
  writes, parameters, same-file helpers), and `shared/hash-owners.ts` is the
  closed list of modules that may export a hasher. `sha256-over-json-stringify`
  and `no-exported-hasher` both read them, so the two rules cannot disagree on
  what a digest or an owner is.

## How a rule is proven

`pnpm check:oxlint-plugin` discovers every rule in this directory. It fails
when a rule has no fixture file, is not registered in `index.ts`, or fails a
fixture case. Then it lints each `invalid` fixture case that the root config can
reproduce (no `filename`, `options` or `settings`) through `.oxlintrc.json`, and
fails unless the rule reports each one at `error`. So a new rule needs:

1. the rule and its fixtures here;
2. an entry in `index.ts`;
3. `"alfred/<rule-id>": "error"` in the root `.oxlintrc.json`.

A rule is registered at `error` only when the tree has zero violations of it.
Report a real violation and fix it first, in its own change.

A deliberate exception takes a disable comment with its reason, as for any
other rule in this repo:

```ts
// oxlint-disable-next-line alfred/no-function-wrapper-shim -- <why this getter is not a second door>
```

`pnpm lint` reports a disable comment that suppresses nothing, so a stale one
fails the build.

## Rules

| Rule                                    | What it rejects                                                                                                                                                                                                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hand-rolled-key-guard`                 | a hand-written key test of a closed table: `Object.hasOwn(TABLE, x)`, `hasOwnProperty`, `x in TABLE`, `Reflect.has`, or `TABLE[x] === undefined` / `== null`. The last forms are true for an inherited key such as `"toString"` (#1516). Use `keyGuard(TABLE)` from `@alfred/contracts`. |
| `log-caught-error-under-err`            | a caught error in a `logger.<level>(…)` call under a key that is not `err`, or a derived form of it (`.message`, `.stack`, a call) under `err` or in the message. Only `err` goes through the redacting serializer. `safeErrorDiagnostic(err)` is allowed under any key.                 |
| `motion-safe-variant-animate`           | a variant-prefixed `animate-*` utility without `motion-safe:` on an element that has `motion-reduce:animate-none`. The variant selector has a higher specificity, so the animation runs under reduced motion.                                                                            |
| `no-brand-mint-outside-owner`           | a type guard (`x is Brand`) or a `z.custom<Brand>()` of a `unique symbol` brand outside its owner file in the `BRANDS` table. Both mint the brand with no cast. Also a brand that `BRANDS` does not list.                                                                                |
| `no-conditional-motion-ref`             | a `ref` that a `?:` or a logical expression chooses, on an `m.*` or `motion.*` element. motion reads the ref only at mount.                                                                                                                                                              |
| `no-constants-re-export`                | a logic file that hands out a value of a `constants` module again: `export { X } from`, `export * from`, or an export of a name that a constants import binds, also through a module `const` alias. Only the package barrels in its `OWNERS` may.                                        |
| `no-dash-in-web-copy`                   | an em dash or an en dash in a string, a template literal or JSX text in `apps/web`. The copy voice has none.                                                                                                                                                                             |
| `no-delta-class-utility-collision`      | a `scale-*` utility without `not-active:` on an `app-press` element, and a `translate-*` utility on an `app-hover-lift` element. The utility wins over the delta class.                                                                                                                  |
| `no-exported-hasher`                    | a function exported from a module that is not a hash owner (`shared/hash-owners.ts`), whose parameter flows into a digest, and a re-export of an owner hasher. Hash through `sha256Hex` or `sha256Canonical` from `@alfred/db/hash`.                                                     |
| `no-function-wrapper-shim`              | an exported function that only returns a constant or an imported name (a second door to the same value)                                                                                                                                                                                  |
| `no-never-sentinel-binding`             | a variable with a `never` annotation inside a `switch` clause, such as `const _exhaustive: never = value`. The binding compiles anywhere, so a value from a newer peer leaks out as a result. Use `assertNever(value, what)` or return a real value.                                     |
| `no-type-alias-shim`                    | an exported type alias, or an empty interface, that is only a new name for an imported type. A sanctioned rename that documents its fact is in its `OWNERS`.                                                                                                                             |
| `no-type-re-export-shim`                | `no-constants-re-export` for a type: `export type { … } from`, `export { type X } from`, `export type * from`, or an export of a name that a type-only constants import binds.                                                                                                           |
| `no-union-enum-without-default`         | an Elysia `t.UnionEnum` call with no `default` key in its options: a missing field would silently arrive as the first member. Pass `{ default: undefined }` and put the default in the handler (`??`).                                                                                   |
| `sha256-over-json-stringify`            | a hash digest (`createHash(…).update`, a bound hasher, `subtle.digest`, an imported owner hasher `sha256Hex`/`sha256Canonical`) over `JSON.stringify` output, whose pre-image depends on key order. Use `sha256Canonical`.                                                               |
| `switch-literal-needs-default`          | a `switch` whose cases are all string literals and that has no `default`. A stored row or a peer at deploy skew can hold a member this build does not know, and it matches no case.                                                                                                      |
| `transition-names-individual-transform` | a `transition-[…transform…]` list that does not name the `scale`, `translate` or `rotate` property that a Tailwind v4 utility on the element writes, so the change snaps.                                                                                                                |
