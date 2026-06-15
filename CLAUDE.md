# Alfred — agent orientation

Alfred is a personal AI assistant: single user, multi-device, connected to email, calendar, and other integrations for background workflows and day-to-day answers.

This is a **pnpm workspace monorepo**. Packages are `@alfred/*` (never `@milkpod/*`), and `pnpm check-types` works on a fresh tree without a prior build.

## Non-negotiables

- **Never `db:push` outside local exploration.** Always `db:generate` -> `db:migrate`.
- **Never import server packages into `apps/web`'s runtime bundle.** `@alfred/api`, `@alfred/auth`, `@alfred/db`, `@alfred/env`, and `@alfred/ai` pull in Node-only code. `pnpm check:web-boundaries` enforces this.
- **Don't use `process.env` directly** — go through `serverEnv()` from `@alfred/env/server`.
- **Read [decisions.md](./decisions.md) before proposing architecture changes** — 25 ADRs cover every major choice and rejection.

## Read When Needed

Progressively disclose the details:

- [docs/reference/code-style.md](./docs/reference/code-style.md) — code style + review checklist. **Read before writing or reviewing code.** Leads with the type-duplication rules (derive from `$inferSelect` / `z.infer`, never hand-roll a source-of-truth shape).
- [docs/reference/architecture.md](./docs/reference/architecture.md) — monorepo layout, how web/API/auth/DB coordinate, package boundaries, env vars.
- [docs/reference/typescript.md](./docs/reference/typescript.md) — `moduleResolution`, `verbatimModuleSyntax`, per-package typecheck.
- [docs/reference/elysia.md](./docs/reference/elysia.md) — request lifecycle, auth macro, error handler, session cache.
- [docs/reference/database.md](./docs/reference/database.md) — Drizzle schema workflow, `createId`, `lifecycle_dates`, BullMQ/Redis factories.
- [docs/reference/auth.md](./docs/reference/auth.md) — Better Auth + Google allowlist, GCP/GitHub OAuth setup.
- [docs/reference/ai-sdk.md](./docs/reference/ai-sdk.md) — AI SDK v6 gotchas, model dispatchers, embeddings, cost attribution.
- [docs/reference/replicache.md](./docs/reference/replicache.md) — sync architecture + recipe for adding a new synced entity.
- [docs/reference/milestones.md](./docs/reference/milestones.md) — milestone history and current status (m1–m15).
- Domain pipelines: [email triage](./docs/reference/triage.md), [morning briefing](./docs/reference/briefing.md), [cold-start research](./docs/reference/cold-start.md).
- Active plans live in [docs/plans/](./docs/plans/) — current implementation plans (m13, triage/briefing v2, write surface) plus the original scaffolding plan.
