# Alfred

A personal AI assistant — single user, multi-device. Connects to Gmail, Calendar, Slack, Linear, and GitHub to run background workflows (morning briefing, email triage, meeting prep) and answer questions about your day.

Architecture decisions are documented exhaustively in [`decisions.md`](./decisions.md).

## Stack

| Layer         | Choice                                                         |
| ------------- | -------------------------------------------------------------- |
| Monorepo      | pnpm + Turborepo                                               |
| Server        | Elysia (Node) + Eden typed client                              |
| Web           | Vite + TanStack Router (SPA)                                   |
| Database      | Postgres + pgvector (Railway)                                  |
| Cache / Queue | Redis — BullMQ + Pub/Sub (Railway)                             |
| Sync          | Replicache (multi-device)                                      |
| Realtime      | Postgres outbox → Redis Pub/Sub → SSE                          |
| Auth          | Better Auth — email OTP + passkey, one-email allowlist         |
| AI            | Vercel AI SDK — Anthropic primary, Google fallback             |
| Embeddings    | Voyage (1024 dim, HNSW) with Gemini fallback                   |
| Web search    | Perplexity Sonar Pro (live) + Sonar Deep Research (onboarding) |
| Hosting       | Railway                                                        |

## Local setup

```bash
# 1. Start Postgres + Redis
docker-compose up -d

# 2. Fill in secrets
#    apps/server/.env and apps/web/.env are already created with blank values
vim apps/server/.env

# 3. Install dependencies
pnpm install

# 4. Build packages (required before type-checking)
pnpm build

# 5. Apply DB migrations
pnpm db:generate
pnpm db:migrate

# 6. Start dev servers
pnpm dev
# → server on :3001, web on :3000
```

## Environment variables

All required vars live in `apps/server/.env`. The blank template is committed to the repo. Required keys:

| Var                            | Purpose                         |
| ------------------------------ | ------------------------------- |
| `DATABASE_URL`                 | Postgres connection string      |
| `REDIS_URL`                    | Redis connection string         |
| `BETTER_AUTH_SECRET`           | ≥32-char random string          |
| `BETTER_AUTH_URL`              | Server base URL                 |
| `ALFRED_ALLOWED_EMAIL`         | Comma-separated emails allowed to sign up |
| `RESEND_API_KEY`               | Transactional email (OTP codes) |
| `RESEND_FROM_EMAIL`            | Sender address                  |
| `ANTHROPIC_API_KEY`            | Primary LLM                     |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Fallback LLM + embeddings       |

Optional (safe to leave blank locally): `OPENAI_API_KEY`, `VOYAGE_API_KEY`, `PERPLEXITY_API_KEY`, and the observability keys (`SENTRY_DSN`, `LANGFUSE_*`, `POSTHOG_API_KEY`).

## Commands

```bash
pnpm dev             # start both apps in watch mode
pnpm build           # production build of all packages
pnpm check-types     # tsc across all packages
pnpm db:generate     # generate Drizzle migration from schema diff
pnpm db:migrate      # apply pending migrations
pnpm db:studio       # open Drizzle Studio
```

## Implementation milestones

Progress tracked against the 15-milestone plan in [`scaffolding-plan.md`](./scaffolding-plan.md).

- [x] 1 — Scaffold (monorepo, all packages, `/health` end-to-end)
- [ ] 2 — Auth + first Railway deploy
- [ ] 3 — Replicache multi-device sync
- [ ] 4 — Realtime stack (outbox → Redis → SSE)
- [ ] 5 — Durable agent runtime (checkpoints + HIL interrupts)
- [ ] 6 — Cost metering (`metered()` helper + `api_call_log`)
- [ ] 7 — Gmail integration end-to-end
- [ ] 8 — Memory primitives (`user_facts`, `style_profiles`, correction loop)
- [ ] 9 — Email triage workflow
- [ ] 10 — Morning briefing workflow
- [ ] 11 — Cold-start research (Perplexity Sonar Deep Research)
- [ ] 12 — Skills + user-authored workflows
- [ ] 13 — Boss + sub-agent orchestration
- [ ] 14 — MCP client
- [ ] 15 — Observability (Sentry + PostHog + Langfuse)

## Architecture decisions

Each non-obvious choice has a numbered ADR in [`decisions.md`](./decisions.md). Read it before proposing architectural changes — most alternatives have already been considered and rejected with reasoning.
