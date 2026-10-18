# Alfred oxlint rules

First-party oxlint rules, written for this repo. This is different from
`scripts/oxlint/anti-slop/`, which is a vendored copy of upstream source that we
keep close to upstream. We own these rules, and `pnpm lint` lints their source
like any other script.

A rule goes here when a gate needs scope or AST structure that a regex in
`scripts/consolidation-rules.mjs` cannot see: which binding a name resolves to,
the kind of a parameter, or how deep an argument is nested.

- Each rule is `rules/<rule-id>.ts`. `index.ts` registers it, and the rules
  object stays sorted by key.
- Each rule has its fixtures in `rules/<rule-id>.rule-test.ts`, a RuleTester run
  with valid and invalid cases. Run one with
  `node --experimental-strip-types scripts/oxlint/alfred/rules/<rule-id>.rule-test.ts`.
  The `.rule-test.ts` name has the same reason as in anti-slop: `*.test.ts` is a
  name that the DB test-id census claims.
- `.oxlintrc.json` loads the plugin from `jsPlugins` and enables each rule as
  `alfred/<rule-id>`. A rule's file scope is set there with `overrides`.
- An exception is an `// oxlint-disable-next-line alfred/<rule-id> -- <reason>`
  comment. `pnpm lint` reports a directive that no longer suppresses anything.
- `.claude/hooks/helper-hints.mjs` reads only the consolidation table. It does not
  hint these rules while a file is being edited.

## Rules

| Rule                         | What it rejects                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sha256-over-json-stringify` | a hash digest (`createHash(…).update`, a bound hasher, `subtle.digest`) over `JSON.stringify` output, whose pre-image depends on key order. Use `sha256Canonical`. |
