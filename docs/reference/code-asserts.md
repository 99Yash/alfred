# Code asserts — what can be a lint and what stays a checklist

The rules in `code-style.md` span mechanical checks (`pnpm check` fails) and
review judgment. This file maps each assert to its enforcement so you know
where to put a new invariant.

## Lint-ratcheted (fails `pnpm check`)

| Assert | Rule | Where it lives |
| --- | --- | --- |
| `Record<string, any>` defeats `unknown` guards | `typescript/no-restricted-types` | `.oxlintrc.json:typescript/no-restricted-types` |
| `Record<string, unknown>` as open dict without contract | `anti-slop/no-unsafe-dictionary-type` (`warn` → ratchet to `error` when tree is clean) | `scripts/oxlint/anti-slop/` |
| Widening a known literal to `Record`/`unknown` | `anti-slop/no-known-value-widening` (`error`) |
| Widen then assert back (`unknown` → `as T`) | `anti-slop/no-widen-then-assert` (`error`) |
| Chained `as` / angle-bracket asserts | `anti-slop/no-chained-type-assertions` (`error`) |
| `unknown` in a type alias that leaks to callers | `anti-slop/no-unknown-type-aliases` (`error`), `no-unknown-returns` (`warn`) |
| `typeof` over unparsed wire values instead of boundary parse | `anti-slop/no-runtime-typeof` (`warn`) |
| Type assertions without `SAFETY:` comment | `anti-slop/require-safety-comment-for-type-assertion` (`warn`) |
| `vi.mock`/`jest.mock` | `anti-slop/no-module-mocking` (`error`) |
| `Record<string, any>` already covered | `typescript/no-restricted-types` |
| `process.env.*` outside `serverEnv()` | `scripts/consolidation-rules.mjs` `gate: no-process-env` |
| Spreading overrides over defaults | `gate: spread-over-defaults` (`withDefaults`) |
| Duplicate helper bodies | `pnpm dup` (jscpd) — cure, not prevention |

These are the cheap place for a new invariant **if it can be phrased as a
syntax shape**. The vendored `anti-slop` set is deliberately small; a new
rule is added only after its violations are driven to zero at `warn` first
(`README` in `scripts/oxlint/anti-slop/`). Prefer a `hint` → `gate` promotion
over a permanently noisy `warn`.

## Review / compile-time pinned (no lint, but checkable)

| Assert | Why lint is a poor fit | How we pin it |
| --- | --- | --- |
| Derive row types from `$inferSelect` / `$inferInsert`, not hand-rolled `interface` | Correct derive depends on `Pick`/`Omit` shape equality and on trick columns (`jsonb`→`unknown`, `numeric`→`string`, `.$type<Brand>()`); a generic "hand-rolled equals infer" checker cannot separate intentional reshapes (`Synced*`) from drift | `tsc` + named row-type exports (`Document`, `NewArtifact`); review hit-list `code-style.md:1` |
| One owning schema per contract — consumers `pick`/`omit`/`extend`/`satisfies z.ZodType<>` | Placement is ownership-by-role, not file type (`schemas.md: placement follows consumer need` — `contracts` for browser+server, `@alfred/sync` for Replicache, provider client for wire, colocate only for one-feature/one-payload). Per-package `schemas/` directories are rejected (`code-style.md: Rejected: per-package schemas/` + `research/schema-and-const-homes-2026-08-22.md`): they concentrate files, not complexity, and a generic `schemas.ts` gate would miss the seam | `pnpm schemas --dupes` discovery aid + `satisfies z.ZodType<>` / `rowToCredentialWire` compile pins; `code-style.md:1` |
| `isRecord`/`getPath` only at true `unknown` boundaries — not on already-typed/SDK values | The guard's *name* is the same on both sides; lint would have to know whether the input was genuinely `unknown` vs `z.infer`/row/SDK type, which is a type-flow question | Review + `anti-slop` ratchets above (unsafe-dict / known-value-widening / widen-then-assert fire downstream of a misplaced `isRecord`); `contracts/AGENTS.md: isRecord is a boundary guard` + `ai/AGENTS.md: SDK objects, not JSON records` |
| Constants at narrowest stable owner — `@alfred/contracts` only for cross-boundary (wire limits, synced enums, `contracts`-visible caps), else owning package/module, `env` only for deploy knobs | `42` vs `EMPTY_COMPLETION_MAX_RETRIES = 42` is context-dependent; a literal ban fires on transparent arithmetic and forces false abstractions | Review per `code-style.md: Constants and configuration ownership` |
| A dedicated `constants.ts` / `config.ts` earns its place only when values couple (several derived expressions depend on one knob, e.g. `packages/env/src/pool.ts: derivePoolMax()` from `AGENT_WORKER_CONCURRENCY_DEFAULT`) — proximity alone does not justify one; an uncoupled grab-bag fails the deletion test | A file-exists gate would force a `constants.ts` per package and hide the coupling test | Review + `code-style.md: A dedicated constants file earns its place only when values couple` |
| Zod schemas vs hand-rolled `interface` drift — `z.infer` is source, not parallel | An `interface` that merely overlaps a schema today should evolve independently only when intentional (`Synced*` reshapes); otherwise `Pick`/`z.infer` keeps them in sync | `code-style.md: Never hand-roll a type that already exists` |

Add a new row here when you touch `code-style.md` so the next reader knows
whether to write a rule or a checklist bullet.
