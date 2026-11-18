# ADR-0129 — Effect is an allowed dependency; the migration is gradual (ACCEPTED — 2026-11-18)

**Status.** Accepted. Owner decision, given in session on 2026-11-18. Amends [ADR-0114](./ADR-0114-effect-runs-the-mcp-connection-lifecycle-and-nothing-else.md) and supersedes its island rule and its per-module-ADR gate. Also the basis for [ADR-0128](./ADR-0128-railway-deployment-config-is-an-alchemy-program.md), whose infra program is the first adoption outside the ADR-0114 island.

**Problem.** The September verdict ("do not adopt Effect") was reversed by ADR-0114 for one module only, with a rule attached: every further Effect use needs its own ADR with its own evidence, and a lint fence keeps `effect` out of every other file. That rule made sense when Effect was unproven in this codebase. It now stands against a runtime that is already in the dependency graph and already in production (`McpConnectionManager`), plus an infra tool (Alchemy) that is Effect-native. The owner has now settled the direction: **Effect may be used elsewhere; there is no problem; the migration is slow, over the long future.**

**Decision.**

- Effect is an allowed runtime dependency for any module that chooses it. A new adoption no longer needs its own ADR; the module records the why in its own change, as any design choice does.
- The pace is **gradual**. Existing `async`/`await` code migrates opportunistically — when a change already touches a module, not on a schedule, and never as a rewrite mandate.
- The per-module boundary discipline of ADR-0114 D1 stays as the pattern, minus the gate: an adopting module keeps its public `Promise` surface until that module itself decides to change it, and it weighs the `runPromise`-at-boundary cost at its own boundary.
- The D6 lint fence stays where it is today. Each adoption adjusts the fence for its own files in the same change, so the fence never lies about what is allowed. The fence's message (not "never Effect", but "Effect only where adopted") is updated by the first adoption after this one.
- `effect` stays pinned exactly in the pnpm catalog and server-only until a web adoption argues otherwise with its own evidence, so the web bundle does not change until then.

## Amendment 2026-11-18 — the first post-ADR adoption, and the catalog bump

The first adoption after this ADR is the [ADR-0128](./ADR-0128-railway-deployment-config-is-an-alchemy-program.md) infra program (`infra/`), and the owner approved the dependency upgrade it needed ("we can upgrade the deps"):

- The catalog `effect` pin moves 4.0.6 → 4.1.4. Alchemy 2.0.0-beta.87 peers on `effect@^4.1.4` (the Railway docs' `effect@rc` is stale and breaks the CLI boot — probe finding), so the two cannot resolve from one catalog entry at 4.0.6. The ADR-0114 island (`mcp/manager.ts`) compiles and its MCP test surface passes 190/190 on the bump; `alchemy`, `@alchemy.run/railway`, and `effect` are pinned together as one catalog triple (ADR-0128 D4).
- "Server-only" now reads "server and the infra program". The infra program is its own workspace package with no `@alfred/*` dependency, so the web bundle is still untouched; a web adoption still needs its own evidence.
- The D6 fence message changed with this adoption, and an `infra/**` allowlist override (with a declared omission) joined the fence — the fence no longer lies about what is allowed.

## Why not islands-only, and why not a rewrite

- **Islands-only.** Rejected by owner correction. The gate now adds friction without protection: the runtime, its patterns, and its costs are settled, and the next honest use is exactly the kind ADR-0128 just made (an infra program).
- **A scheduled rewrite.** Rejected by owner correction: the pace is slow and long-term. Two error models coexist for a while; that is the accepted price, and each adopting module bounds it at its own boundary rather than a repo-wide rule.

## Residual risk

- **Two error models.** Tagged Effect errors and thrown errors coexist during the migration. Each adopting module owns its bridge, as `manager.ts` does; a reader of mixed files sees both styles.
- **Fence drift.** The lint fence is enforced per-module at adoption time. If an adoption forgets to adjust it, the fence wrongly blocks a legitimate import — visible at once, and cheap to fix in the same change.
- **Idiom mixing in one package.** A package may end up half-`async`, half-Effect. The boundary discipline keeps this legible; a package-level consolidation remains each package's own later choice.
