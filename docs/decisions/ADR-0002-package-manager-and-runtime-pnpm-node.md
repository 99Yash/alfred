# ADR-0002 — Package manager and runtime: pnpm + Node

**Decision.** pnpm workspaces + Node runtime, mirroring milkpod's scaffolding.

**Why.** Replicache is the riskiest moving piece, and milkpod is in the middle of validating it on this exact stack — borrow the pattern that's about to be battle-tested. AI SDK + BullMQ + Better Auth all have well-trodden Node deployment paths. The package boundaries hide the runtime, so migrating to Bun later is feasible if it ever pays off.

**Alternatives.** Bun (orys's choice — rejected for the dual-debugging cost on a project that already has unproven sync infra). pnpm + Bun runtime hybrid (rejected — Bun's pnpm support has rough edges).
