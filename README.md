# Alfred

A personal AI assistant — single user, multi-device. Connects to Google Workspace (Gmail, Calendar, Drive, Docs, Sheets, Slides), GitHub, Notion, Railway, and Vercel to run background workflows (morning briefing, email triage, meeting prep) and answer questions about your day.

Slack and Linear still exist in design docs and catalog UI, but they do not have live backend integrations yet.

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
| Auth          | Better Auth — Google OAuth + one-email allowlist               |
| AI            | Vercel AI SDK — Anthropic primary, Google fallback             |
| Embeddings    | Voyage (`voyage-3.5`, 1024 dim, HNSW)                          |
| Web search    | Grounded Gemini 2.5 Flash via Google Search grounding          |
| Email         | Resend transactional email                                     |
| Hosting       | Railway                                                        |

## Local setup

```bash
# 1. Start Postgres + Redis
docker-compose up -d

# 2. Install dependencies
pnpm install

# 3. Create local env files
cp .env.example apps/server/.env
# apps/web/.env only needs browser-safe Vite vars:
printf 'VITE_API_URL=http://localhost:3001\nVITE_SENTRY_DSN=\nVITE_POSTHOG_KEY=\nVITE_POSTHOG_HOST=\n' > apps/web/.env

# 4. Fill in server secrets
vim apps/server/.env

# 5. Apply committed DB migrations
pnpm db:migrate

# 6. Start dev servers
pnpm dev
# → server on :3001, web on :3000
```

No build step is required before `pnpm check-types`; workspace packages export TypeScript source directly.

## Environment variables

Server vars live in `apps/server/.env`; browser-safe Vite vars live in `apps/web/.env`. The committed root [`.env.example`](./.env.example) is the combined reference template.

Required server keys:

| Var                              | Purpose                                      |
| -------------------------------- | -------------------------------------------- |
| `DATABASE_URL`                   | Postgres connection string                   |
| `REDIS_URL`                      | Redis connection string                      |
| `BETTER_AUTH_SECRET`             | >=32-char random string                      |
| `BETTER_AUTH_URL`                | Server base URL                              |
| `ALFRED_ALLOWED_EMAIL`           | Comma-separated emails allowed to sign up    |
| `RESEND_API_KEY`                 | Transactional email                          |
| `RESEND_FROM_EMAIL`              | Sender address                               |
| `ANTHROPIC_API_KEY`              | Primary LLM                                  |
| `GOOGLE_GENERATIVE_AI_API_KEY`   | Fallback/cheap LLM + live web search         |
| `GOOGLE_OAUTH_CLIENT_ID`         | Google sign-in + Workspace integration OAuth |
| `GOOGLE_OAUTH_CLIENT_SECRET`     | Google sign-in + Workspace integration OAuth |
| `GOOGLE_OAUTH_REDIRECT_URI`      | Workspace integration callback URL           |
| `GITHUB_APP_ID`                  | GitHub App installation-token flow           |
| `GITHUB_APP_SLUG`                | GitHub App install URL                       |
| `GITHUB_APP_CLIENT_ID`           | GitHub App user-to-server OAuth              |
| `GITHUB_APP_CLIENT_SECRET`       | GitHub App user-to-server OAuth              |
| `GITHUB_APP_PRIVATE_KEY`         | GitHub App JWT signing key                   |
| `GITHUB_WEBHOOK_SECRET`          | GitHub webhook HMAC verification             |
| `GITHUB_APP_REDIRECT_URI`        | GitHub App callback URL                      |

Feature-gated or optional locally: `OPENAI_API_KEY`, `VOYAGE_API_KEY` (embeddings), `PERPLEXITY_API_KEY` (legacy/research smokes), `GOOGLE_PUBSUB_*` (Gmail push), `NOTION_*`, `VERCEL_*`, `CHAT_S3_*`, `ENTITY_ID_NAMESPACE`, and observability keys (`SENTRY_DSN`, `LANGFUSE_*`, `POSTHOG_API_KEY`, `VITE_SENTRY_DSN`, `VITE_POSTHOG_*`).

`ENTITY_ID_NAMESPACE` (ADR-0067, user-model substrate) is the HMAC namespace for content-addressed stable entity IDs. It is optional today (no projection writes IDs yet) but **once the P1 projection lands it must be set and backed up like an auth secret — changing it remints every entity ID on replay.**

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

Current status is tracked in [`docs/reference/milestones.md`](./docs/reference/milestones.md). The original 15-milestone scaffold lives in [`docs/plans/scaffolding-plan.md`](./docs/plans/scaffolding-plan.md).

## Architecture decisions

Each non-obvious choice has a numbered ADR in [`decisions.md`](./decisions.md). Read it before proposing architectural changes — most alternatives have already been considered and rejected with reasoning.
