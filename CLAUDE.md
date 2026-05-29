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

- [docs/architecture.md](./docs/architecture.md) — monorepo layout, how web/API/auth/DB coordinate, package boundaries, env vars.
- [docs/typescript.md](./docs/typescript.md) — `moduleResolution`, `verbatimModuleSyntax`, per-package typecheck.
- [docs/elysia.md](./docs/elysia.md) — request lifecycle, auth macro, error handler, session cache.
- [docs/database.md](./docs/database.md) — Drizzle schema workflow, `createId`, `lifecycle_dates`, BullMQ/Redis factories.
- [docs/auth.md](./docs/auth.md) — Better Auth + Google allowlist, GCP/GitHub OAuth setup.
- [docs/ai-sdk.md](./docs/ai-sdk.md) — AI SDK v6 gotchas, model dispatchers, embeddings, cost attribution.
- [docs/replicache.md](./docs/replicache.md) — sync architecture + recipe for adding a new synced entity.
- [docs/milestones.md](./docs/milestones.md) — milestone history and current status (m1–m15).
- Domain pipelines: [email triage](./docs/triage.md), [morning briefing](./docs/briefing.md), [cold-start research](./docs/cold-start.md).
