# Alfred — Scaffolding Plan (handoff doc)

This document is a self-contained brief for the agent that will scaffold the alfred repo. You don't need to have participated in the design conversation — read this plus `decisions.md` and you have everything.

## Read first (in this order)

1. **`./decisions.md`** — the 25 architectural ADRs that define the stack. The _why_ of every choice.
2. **`./dimension-dev-recon.md`** — research on dimension.dev's architecture, used as a reference point. Do not over-mirror; ADRs explain where we deviate.
3. **`../milkpod/CLAUDE.md`** — milkpod's repo orientation. Alfred mirrors its monorepo shape.
4. **`../milkpod/ARCHITECTURE.md`** — milkpod's architecture (different product, same scaffolding patterns). Useful for understanding the package boundaries.
5. **`../milkpod/AGENTS.md`** — milkpod's day-to-day conventions. Most apply to alfred verbatim.
6. **`../milkpod/docs/`** (especially `database.md`, `package-boundaries.md`, `conventions.md`, `environment.md`, `typescript-patterns.md`) — best-practice references; transfer as-is.

## Goal of this milestone

Implement **milestone 1 of the suggested implementation order in `decisions.md`**: scaffold alfred from milkpod's structure. By the end:

- `pnpm install` succeeds at the alfred root.
- `pnpm dev` boots both `apps/server` (Elysia, port 3001) and `apps/web` (Vite + TanStack Router SPA, port 3000).
- `pnpm check-types` passes across all packages.
- A trivial Eden-typed call (`/health`) goes from web → server and types end-to-end.
- A trivial Drizzle migration runs against a local Postgres in `docker-compose.yml`.
- No business logic implemented yet — this is _only_ scaffolding.

**Stop at "hello-world works." Do not start implementing features.** Subsequent milestones (Replicache, durable runtime, integrations, etc.) are separate sessions.

## Repo layout to create

```
alfred/
├── apps/
│   ├── server/         # Elysia API (port milkpod's; rewrite app contents)
│   └── web/            # Vite + TanStack Router SPA (NEW; not in milkpod)
├── packages/
│   ├── ai/             # AI SDK helpers, tools, embeddings, model dispatcher (port milkpod's structure)
│   ├── api/            # Elysia routes, Eden types (port milkpod's structure)
│   ├── auth/           # Better Auth integration (port milkpod's mostly-verbatim)
│   ├── config/         # shared tsconfig (copy milkpod's verbatim)
│   ├── db/             # Drizzle schema + migrations (port milkpod's harness, rewrite schema)
│   ├── env/            # env-var validation (copy milkpod's verbatim)
│   ├── sync/           # Replicache mutators + types (port milkpod's structure; do NOT port mutators)
│   ├── integrations/   # NEW — one folder per provider (Gmail, Calendar, etc.)
│   └── ingestion/      # NEW — shared chunker, embedder, dedup utilities
├── docker-compose.yml  # Postgres + Redis (copy milkpod's, rename DB)
├── pnpm-workspace.yaml # copy milkpod's verbatim (catalog can be trimmed)
├── turbo.json          # copy milkpod's verbatim
├── package.json        # copy milkpod's, rename to "alfred"
├── tsconfig.json       # copy milkpod's verbatim (extends config package)
├── .gitignore          # copy milkpod's verbatim
├── .nvmrc              # copy milkpod's verbatim
└── CLAUDE.md           # NEW — alfred's orientation doc; sketch in this milestone
```

## What to copy verbatim (modulo `@milkpod/*` → `@alfred/*` namespace rename)

These can be lifted with minimal adaptation:

- **Root config**: `pnpm-workspace.yaml`, `turbo.json`, `package.json` (rename to `"alfred"`), `tsconfig.json`, `.gitignore`, `.nvmrc`, `docker-compose.yml`
- **`packages/config/`** — entire package; just rename to `@alfred/config`
- **`packages/env/`** — entire package; rename. Adapt `src/server.ts` and `src/client.ts` to alfred's env-var list (see "Environment variables" below).
- **`packages/auth/`** — copy structure: `index.ts`, `session.ts`, `signup-hooks.ts`, `otp-email.ts`, `otp-email-template.ts`, `invite-email.ts`, `invite-email-template.ts`. Add the **one-email allowlist** in the signup hook per ADR-0009 (env var `ALFRED_ALLOWED_EMAIL`).
- **`packages/sync/`** — copy structure (`index.ts`, `keys.ts`, `types.ts`, `mutators/`). **Do not port milkpod's mutators** (`comments.ts`, `moments.ts`, `notifications.ts`) — those are milkpod-specific. Leave `mutators/` empty with a placeholder `index.ts` that re-exports nothing yet. Replicache wiring proper happens in milestone 3.

## What to adapt heavily

**`packages/db/`** — port the Drizzle harness + scripts (`drizzle.config.ts`, `package.json` scripts for `db:generate`, `db:migrate`, `db:studio`, `db:push`), but **rewrite schema entirely**.

For this milestone, ship a _minimal_ schema — just enough to verify migrations work:

```ts
// packages/db/src/schema/user.ts
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// packages/db/src/schema/session.ts (Better Auth-compatible)
// packages/db/src/schema/account.ts (Better Auth-compatible)
// packages/db/src/schema/verification.ts (Better Auth-compatible)
```

Better Auth requires specific tables; mirror milkpod's auth-related schema files. Don't add domain tables yet (those come in later milestones — see ADRs 0010, 0012, 0013, 0015, 0016, 0019, 0021, 0024, 0025 for the eventual schema).

Drop `pgvector` extension setup as a migration so it's ready: `CREATE EXTENSION IF NOT EXISTS vector;`.

**`packages/api/`** — port the structure: `index.ts`, `middleware/`, `modules/`, `routers/`, `schemas.ts`, `types.ts`, `utils.ts`, `events/`, `queue/`. **Rewrite the contents** for alfred:

- `routers/` should expose a single trivial `/health` route returning `{ ok: true }` for milestone 1.
- `middleware/` should keep auth middleware shape but tied to `@alfred/auth`.
- `queue/` ships the BullMQ setup wired to `@alfred/env`'s `REDIS_URL`. No actual workers yet.
- `events/` — outbox table + Redis Pub/Sub relay scaffolding (per ADR-0005). Compose the structure but leave the relay as a stub that can be filled in milestone 4.

**`packages/ai/`** — port the structure: `index.ts`, `provider.ts`, `models.ts`, `embeddings.ts`, `tools.ts`, `system-prompt.ts`, `stream.ts`. **Rewrite contents**:

- `provider.ts` should use AI SDK with Anthropic + Google providers (skip OpenAI if no creds — silent skip per ADR-0016).
- `embeddings.ts` should be a `embed(text, opts)` function with Voyage primary + Gemini fallback (ADR-0021), but **stub the Voyage call** (return a fixed-size zero vector); real wire-up is in milestone 7. The point is the module shape and call signature.
- `models.ts` exports a model dispatcher per ADR-0016 (capability tags → provider/model). Stub with a minimal map.
- Skip `retrieval.ts`, `guardrails.ts`, `plans.ts`, `title.ts`, `translation.ts`, `number-words.ts`, `schemas.ts` — those are milkpod-specific.

**`apps/server/`** — port the bootstrap pattern (`src/index.ts`, `tsdown.config.ts`, `package.json` scripts). **Rewrite contents**:

- `src/index.ts` — Elysia app with CORS, attached `@alfred/api`, listens on port 3001.
- Remove milkpod's S3/AWS deps; alfred doesn't need S3 yet.

## What to build from scratch (no milkpod equivalent)

**`apps/web/`** — Vite + TanStack Router SPA. milkpod has Next.js App Router; alfred uses Vite (ADR-0003). Build fresh:

```bash
# Approximate setup
pnpm create vite apps/web --template react-ts
cd apps/web
pnpm add @tanstack/react-router @tanstack/react-query @elysiajs/eden
pnpm add -D @tanstack/router-vite-plugin @tanstack/router-devtools
```

- `apps/web/src/main.tsx` — React root with TanStack Router + QueryClient
- `apps/web/src/router.ts` — TanStack Router config with file-based routing in `src/routes/`
- `apps/web/src/routes/__root.tsx` — root layout with auth guard
- `apps/web/src/routes/index.tsx` — placeholder home route that calls the Eden client to hit `/health`
- `apps/web/src/lib/eden.ts` — Eden client typed against `@alfred/api`
- `apps/web/vite.config.ts` — TanStack Router plugin + path aliases + proxy `/api` → `localhost:3001` for dev
- Tailwind v4 (mirror milkpod's setup; `@tailwindcss/postcss`, `tailwindcss`)
- shadcn/ui scaffold (`components.json`, `lib/utils.ts`); skip components for now, add as needed

Do **not** copy milkpod's web app verbatim — it's App Router and full of asset/transcription UI. Build alfred's web app fresh, using milkpod's `components/ui/` and `lib/utils.ts` and `hooks/` only as reference for shadcn/Tailwind patterns.

**`packages/integrations/`** — empty package, ready for first integration in milestone 7. Create the package shell:

```
packages/integrations/
├── package.json     # @alfred/integrations
├── tsconfig.json
├── tsdown.config.ts
└── src/
    ├── index.ts     # placeholder export
    └── README.md    # "one folder per provider; each exports oauthFlow, liveTools, ingestor, webhookHandler"
```

**`packages/ingestion/`** — empty package, ready for milestone 7. Same shell shape:

```
packages/ingestion/
├── package.json     # @alfred/ingestion
├── tsconfig.json
├── tsdown.config.ts
└── src/
    ├── index.ts     # placeholder export
    └── README.md    # "shared chunker, embedder, dedup, vector-write helpers"
```

## Catalog dependencies (in `pnpm-workspace.yaml`)

Port milkpod's catalog with minor edits:

- Keep all of milkpod's catalog entries.
- **Remove**: anything S3 / AWS / AssemblyAI (milkpod-specific).
- **Add**: `@tanstack/react-router`, `@tanstack/router-vite-plugin`, `vite`, `voyageai` (or whatever the official Voyage TS SDK is named at install time — check models.dev), `@modelcontextprotocol/sdk` (for MCP client; future milestone but adding to catalog now is fine), `@langfuse/langfuse-node` (future).

## Environment variables expected

Add to `packages/env/src/server.ts`:

```ts
DATABASE_URL: z.string().url(),
REDIS_URL: z.string().url(),
BETTER_AUTH_SECRET: z.string().min(32),
BETTER_AUTH_URL: z.string().url(),
ALFRED_ALLOWED_EMAIL: z.string().email(),
RESEND_API_KEY: z.string(),
RESEND_FROM_EMAIL: z.string().email(),

// AI providers (Anthropic + Google now; OpenAI later)
ANTHROPIC_API_KEY: z.string(),
GOOGLE_GENERATIVE_AI_API_KEY: z.string(),
OPENAI_API_KEY: z.string().optional(),

// Embedding + search
VOYAGE_API_KEY: z.string().optional(),    // optional until milestone 7
PERPLEXITY_API_KEY: z.string().optional(),

// Observability
SENTRY_DSN: z.string().optional(),
LANGFUSE_PUBLIC_KEY: z.string().optional(),
LANGFUSE_SECRET_KEY: z.string().optional(),
LANGFUSE_HOST: z.string().url().optional(),
POSTHOG_API_KEY: z.string().optional(),
```

`packages/env/src/client.ts` — minimal at this milestone, just `VITE_API_URL` for the Vite app.

`apps/web` reads via `import.meta.env.VITE_*`; do not pull `@alfred/env`'s server schema into the browser bundle.

Add `.env.example` at the repo root listing every var.

## Conventions to enforce from day one

These come from milkpod's docs/ and apply to alfred:

- **All packages export TS source via `"default": "./src/*.ts"`** (the `tsdown` build only emits `.d.ts` for downstream type resolution). See `../milkpod/docs/package-boundaries.md`.
- **After editing schema files, run `pnpm build` before `pnpm check-types`** — downstream packages resolve types from `dist/`. Stale `.d.ts` files surface as phantom type errors.
- **No transitive package imports** — `apps/web` imports `@alfred/api` types only via the Eden client, not by directly reaching into routes.
- **`server-only` import** at the top of any module that must not run in the browser (auth, DB, AI providers).
- **Drizzle migrations**: `pnpm db:generate` then `pnpm db:migrate`. Never `db:push` in CI; only for local exploration.

## Acceptance criteria for milestone 1

When all of these pass, scaffolding is done:

- [ ] `pnpm install` at root succeeds.
- [ ] `docker-compose up -d` brings up Postgres + Redis.
- [ ] `pnpm db:generate && pnpm db:migrate` applies the initial Better-Auth-compatible schema, including `CREATE EXTENSION vector;`.
- [ ] `pnpm dev` boots both apps:
  - `apps/server` listens on `:3001`, responds to `GET /health` with `{ ok: true }`.
  - `apps/web` serves on `:3000`, renders the home route, the home route fetches `/health` via Eden client, displays the result.
- [ ] `pnpm check-types` passes across all packages.
- [ ] `pnpm build` succeeds for all packages.
- [ ] A passkey-or-magic-link login flow works via Better Auth (basic shadcn login form on `/login` route in web; Better Auth endpoints registered on server). Allowlist enforced — only `ALFRED_ALLOWED_EMAIL` can sign up.
- [ ] No business logic beyond the above. No mutators, no agent runtime, no integrations, no metering — placeholders only.

## What NOT to do in this milestone

- **Do not implement Replicache mutators or wire up the sync engine.** The package shell exists; mutators come in milestone 3.
- **Do not implement the durable agent runtime.** Milestone 5.
- **Do not start any integration (Gmail, etc.).** Milestone 7.
- **Do not seed `model_prices` or build `metered()`.** Milestone 6.
- **Do not stub realtime SSE beyond the package structure.** Milestone 4.
- **Do not write features.** This is plumbing only.

If you find yourself reaching for any of those, stop and revisit `decisions.md` — those are separate milestones with their own briefs.

## When you're done

- Commit message format follows milkpod's convention (check `git log` in `../milkpod`). Sign off with the same Co-Authored-By line.
- Hand back: a list of any deviations from this plan (with reasons), and a confirmation that all acceptance criteria pass.
- The next session will pick up at milestone 2 (auth + first deploy) or milestone 3 (Replicache MVP) depending on user direction.

---

## Lessons from the M1 → M2 transition (2026-04-28)

These bugs hit when M2 deployed to Railway. Future scaffolds should avoid them:

1. **`db:generate` was never run during M1** — schema files existed but no `packages/db/src/migrations/*.sql` files. preDeploy `drizzle-kit migrate` failed against an empty migrations folder. **Fix**: generate the initial migration as part of M1 acceptance (`pnpm --filter @alfred/db db:generate`) and commit it. Add to the acceptance checklist.

2. **Server hardcoded `port: 3001`** — Railway injects `PORT` at runtime and routes external traffic to whatever the container listens on. Hardcoded port = unreachable healthcheck. **Fix**: server entrypoint should be `port: Number(process.env.PORT) || 3001, hostname: '0.0.0.0'`. Add to acceptance criteria.

3. **`pgvector` extension not in migration** — M1 plan called for `CREATE EXTENSION IF NOT EXISTS vector;` to be ready, but the schema-derived migration didn't include it. **Fix**: prepend it to the first migration file (drizzle-kit doesn't manage extensions natively).

4. **Interactive `railway add --database` prompts created duplicate services** — even when `--database postgres` is specified, the CLI still shows "What do you need?" prompt; piping empty stdin doesn't fully suppress it; multi-flag invocations create extra zombie services. **Fix**: add one database at a time with explicit `--database <type>` and verify only one new service appeared in `railway service status --all --json` before moving on.

5. **`serviceDelete` GraphQL mutation doesn't actually delete** — it renames services with a UUID suffix and leaves deployments running. **Fix**: use `railway environment edit --json` with `{"services":{"<id>":{"isDeleted":true}}}` instead.

6. **Watch-pattern diff blocks `railway up` retries** — when a deploy fails on transient infra issues (e.g., `mise install node@22` network error) and you `railway up` to retry, Railway compares against the previous failed deploy's snapshot and skips with `"No changes to watched files"`. **Fix**: make a real (or trivial-but-real) change to a watched path to force the diff. Empty commits don't trigger.

7. **better-auth@1.6.9 doesn't export `./plugins/passkey`** — passkey was removed from the main package mid-reorganization. **Fix**: ship emailOTP only at v1 (covers the magic-link half of ADR-0009). Revisit when better-auth's plugin layout stabilizes or wire `@simplewebauthn/server` directly.
