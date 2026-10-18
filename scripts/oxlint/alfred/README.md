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

The edit-time hook does not read this plugin. A rule here fails `pnpm lint`,
but it gives no hint while an agent writes the file.

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
  the table, and the rule needs no `overrides` entry in `.oxlintrc.json`.

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

| Rule                         | What it rejects                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `no-function-wrapper-shim`   | an exported function that only returns a constant or an imported name (a second door to the same value)                                                            |
| `sha256-over-json-stringify` | a hash digest (`createHash(…).update`, a bound hasher, `subtle.digest`) over `JSON.stringify` output, whose pre-image depends on key order. Use `sha256Canonical`. |
