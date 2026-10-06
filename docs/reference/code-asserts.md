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
| Type assertions without `SAFETY:` comment | `anti-slop/require-safety-comment-for-type-assertion` (`error`; test/eval scopes exempt) |
| `vi.mock`/`jest.mock` | `anti-slop/no-module-mocking` (`error`) |
| `Record<string, any>` already covered | `typescript/no-restricted-types` |
| `process.env.*` outside `serverEnv()` | `scripts/consolidation-rules.mjs` `gate: no-process-env` |
| Spreading overrides over defaults | `gate: spread-over-defaults` (`withDefaults`) |
| Duplicate helper bodies | `pnpm dup` (jscpd) — cure, not prevention |
| A suppression that suppresses nothing (`eslint-disable` / `oxlint-disable` naming a rule that did not fire) | `oxlint --report-unused-disable-directives-severity=error`, wired into the root `lint` script |
| A rule turned `"off"` for authored source with no stated reason | `scripts/oxlint-config.mjs` `blanketDisarmFailures` (via `check:oxlint-config`) |

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
`// oxlint-disarm: <rule> — <why>` comment beside the key, and skips test/eval/script
scopes, where a blanket `"off"` is the deliberate and correct choice.

It deliberately does **not** report a scope for naming many individual files. The lists
in this config are heterogeneous by design — a boundary parser, a provider client, a
BullMQ processor and a framework seam are all honest `unknown` returns, and no path glob
covers them without exempting every unrelated module beside them. A curated allowlist
is the right shape; what it needs is a stated reason, not a shorter list.

`no-restricted-imports` is excluded from this rule because it is the one rule here
carrying several independent groups, and `restrictedGroupCopyFailures` already demands
a restated copy or a declared omission per group.

These are the cheap place for a new invariant **if it can be phrased as a
syntax shape**. The vendored `anti-slop` set is deliberately small; a new
rule is added only after its violations are driven to zero at `warn` first
(`README` in `scripts/oxlint/anti-slop/`). Prefer a `hint` → `gate` promotion
over a permanently noisy `warn`.

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
