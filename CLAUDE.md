# Alfred Agent Guidance

Alfred is a personal AI assistant in a pnpm workspace monorepo. Packages use the `@alfred/*` scope, and `pnpm check-types` must work on a fresh tree without a prior build.

Read the nearest nested `AGENTS.md` before editing within its subtree.

## Repo-Wide Invariants

- Derive source-of-truth shapes: use named Drizzle row types, `$inferInsert`, and `z.infer` instead of parallel interfaces.
- Keep browser runtime code free of Node-only packages. Type-only imports are allowed only when TypeScript erases them; `pnpm check:web-boundaries` enforces the boundary.
- Treat external, persisted, and protocol data as `unknown`; validate it at the owning boundary instead of asserting it with casts.
- Use `serverEnv()` from `@alfred/env/server`; do not read `process.env` directly.
- Apply database schema changes with `db:generate` then `db:migrate`. Never use `db:push` outside local exploration.
- Put cross-boundary browser-safe contracts in `@alfred/contracts`, Replicache models in `@alfred/sync`, and implementation details in the package or feature that owns them.
- Read [decisions.md](./decisions.md) before changing architecture.

## References

- [Code style and review checklist](./docs/reference/code-style.md) and [structural review](./docs/reference/structural-review.md)
- [Architecture and package boundaries](./docs/reference/architecture.md)
- [TypeScript configuration](./docs/reference/typescript.md)
- [Elysia request lifecycle](./docs/reference/elysia.md)
- [Database conventions](./docs/reference/database.md)
- [Authentication](./docs/reference/auth.md)
- [AI SDK conventions](./docs/reference/ai-sdk.md)
- [Replicache synchronization](./docs/reference/replicache.md)
- Domain pipelines: [email triage](./docs/reference/triage.md), [morning briefing](./docs/reference/briefing.md), and [cold-start research](./docs/reference/cold-start.md)
