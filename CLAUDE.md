# Alfred — agent orientation

Alfred is a personal AI assistant (single user, multi-device). It connects to email, calendar, and other integrations to run background workflows and answer questions about the user's day.

Read [`decisions.md`](./decisions.md) before proposing architecture changes — 25 ADRs cover every major choice and rejection.

One non-standard rule:

- **Never `db:push` outside local exploration.** Always `db:generate` → `db:migrate`.

Workspace packages export TS source directly (`./src/index.ts`), so `pnpm check-types` works on a fresh tree without a prior build.

## Monorepo layout

```
apps/
├── server/          # Elysia HTTP server — port 3001
└── web/             # Vite + TanStack Router SPA — port 3000
packages/
├── ai/              # AI SDK provider config, model dispatcher, embeddings stub
├── api/             # Elysia app (routes + middleware) + Eden App type export
├── auth/            # Better Auth config — emailOTP + one-email allowlist
├── config/          # Shared tsconfig.base.json
├── db/              # Drizzle schema, pool, helpers
├── env/             # Zod-validated env vars — serverEnv() / CLIENT_DEFAULTS
├── sync/            # Replicache mutator stubs (wired in milestone 3)
├── integrations/    # Per-provider shells (Gmail, Calendar, …) — milestone 7
└── ingestion/       # Shared chunker/embedder/dedup helpers — milestone 7
```

All packages are `@alfred/*`. Never import `@milkpod/*`.

## How the pieces coordinate

**Web → API:** `apps/web/src/lib/eden.ts` creates an Eden treaty client typed against `App` from `@alfred/api`. The Vite dev server proxies `/api/auth/*` to `localhost:3001`; all other API calls use `VITE_API_URL` directly.

**Web → Auth:** `apps/web/src/lib/auth-client.ts` creates a Better Auth client with the `emailOTPClient()` plugin. It talks to the Better Auth endpoints mounted on the Elysia server (`/api/auth/*`).

**API → Auth:** `packages/api/src/middleware/session-cache.ts` calls `auth().api.getSession()` with a two-layer cache (per-request WeakMap + 10-second token cache). Import `getSessionCached()` in route handlers; never call `auth()` directly from routes.

**API → DB:** `db()` from `@alfred/db` returns the shared pg pool singleton. Call it inside handlers and workers; do not call it at module init time.

**Server bootstrap:** `apps/server/src/index.ts` awaits `warmPool()` and `initEventBridge()` before binding the port. Graceful shutdown drains Redis then the DB pool on SIGTERM/SIGINT.

## Package boundaries

`@alfred/api` and `@alfred/auth` depend on `@alfred/db` and `@alfred/env`, which pull in Node-only modules (`pg`, `drizzle-orm`). **Never import these packages into `apps/web`'s runtime bundle.**

Allowed in `apps/web`:

- `import type { App } from '@alfred/api'` — type-only, stripped at build time, safe.
- `import { treaty } from '@elysiajs/eden'` — client-side.
- `import { createAuthClient } from 'better-auth/react'` — client-side.

Forbidden in `apps/web`:

- Any non-type import of `@alfred/api`, `@alfred/auth`, `@alfred/db`, `@alfred/env`.
- Any import of `@alfred/ai` (contains server-only AI SDK providers).

Path alias `~/` maps to `src/` in both apps.

## TypeScript conventions

- All packages use `"moduleResolution": "bundler"` and `"verbatimModuleSyntax": true`. Use `import type` for type-only imports.
- `apps/web` uses `tsc --noEmit` for type-checking (not `tsc -b`) — it's a leaf node, not a composite project.
- All other packages use `tsc -b` via composite project references.
- When reading unfamiliar library APIs, inspect type definitions in `node_modules/.pnpm/*/node_modules/<pkg>/dist/*.d.ts` — do not guess from old docs or training data.

## Elysia patterns

Elysia processes requests: `onRequest → transform → beforeHandle → handler → afterHandle → mapResponse → afterResponse`. Errors from any stage after routing jump to `onError`.

Key patterns in this repo:

```ts
// Auth guard via macro (packages/api/src/middleware/auth.ts)
app.use(authMacro).get('/protected', ({ user }) => user, { auth: true });

// Global error handler (packages/api/src/middleware/error-handler.ts)
// Normalises all errors to { error: string, code: string }.
// Throw ApiError subclasses from services; do not set.status manually.

// Session cache (packages/api/src/middleware/session-cache.ts)
// Call getSessionCached(request) — never auth().api.getSession() directly.
```

Plugin scope: hooks registered via `.use(plugin)` apply to routes defined after that call. Use `{ as: 'global' }` on `onError` to catch errors from all plugins.

## Database

Schema lives in `packages/db/src/schema/`. Export everything through `packages/db/src/schemas.ts`.

```bash
# Typical schema change workflow
# 1. Edit packages/db/src/schema/<file>.ts
# 2. pnpm db:generate        ← diff schema → migration SQL
# 3. pnpm db:migrate         ← apply to local DB
# 4. pnpm check-types        ← verify nothing broke
```

Drizzle config reads `DATABASE_URL` from `apps/server/.env`.

`createId(prefix?)` from `packages/db/src/helpers.ts` generates prefixed nanoid IDs (e.g. `createId('usr')` → `usr_abc123`). Use it for all primary keys.

`lifecycle_dates` spread adds `createdAt` / `updatedAt` columns with sane defaults.

## Auth

`packages/auth/src/index.ts` exports `auth()` — the full Better Auth instance with emailOTP and the one-email allowlist hook. Mount it on the Elysia server via `.mount(auth().handler)`.

The allowlist rejects any signup where `user.email !== ALFRED_ALLOWED_EMAIL`. It throws, which Better Auth converts to a 422.

`packages/auth/src/session.ts` exports `sessionAuth()` — a lightweight instance for session-only verification (no emailOTP plugin, no Resend dependency). Used by `session-cache.ts`.

## AI SDK

Alfred uses AI SDK v6 (`ai@^6`). Common v6 differences:

- `maxTokens` → `maxOutputTokens` in `generateText`/`streamText`.
- `maxSteps` → `stopWhen: [stepCountIs(n)]`.
- `tool()` uses `inputSchema`, not `parameters`.
- `LanguageModel` is a union — do not hardcode string model IDs in type positions.
- `generateObject` _@deprecated_ — Use `generateText` with an `output` setting instead.

Model selection: `getBossModel()`, `getSubAgentModel()`, `getCheapModel()`, `getWebSearchModel()`, `getResearchModel()` from `@alfred/ai/provider`. Do not call AI SDK provider functions directly from route handlers. The two web-search models (Perplexity Sonar Pro for live, Sonar Deep Research for cold-start) must be routed through `meteredGenerateText` with `attribution.kind = 'web_search'` so cost rollups bucket them apart from the LLM line.

Embeddings: `embed(text, opts?)` from `@alfred/ai/embeddings` — currently a zero-vector stub; real Voyage wiring comes in milestone 7. All embedding dimensions must be 1024.

## BullMQ / Redis

`createRedisConnection()` from `packages/api/src/queue/connection.ts` returns a tracked IORedis connection (closed on shutdown). Use it for BullMQ Queue and Worker constructors.

`createUntrackedRedisConnection()` is for short-lived probes (health checks) — caller must close it.

Never create raw `new IORedis()` in app code; always use these factories.

## Email triage (m9)

Per ADR-0025 #1 alfred classifies every newly-ingested Gmail message into one of six categories: `action_needed`, `awaiting_reply`, `meeting`, `fyi`, `payment`, `newsletter`. Each category maps to an `Alfred/<Name>` Gmail label that gets written back to the message.

The pipeline:

1. `gmail.poll_history` (BullMQ) inserts a fresh `documents` row.
2. `packages/api/src/modules/integrations/queue.ts` enqueues an `email-triage` agent run per inserted doc (skipped on bulk re-ingest / `fullResync`).
3. The `email-triage` workflow (in `apps/server/src/builtins/workflows/email-triage.ts`) runs `classify` (cheap-tier LLM via `@alfred/ai`'s `metered.object()`) → `apply-label` (`messages.modify`).
4. Result lands in `email_triage` (one row per document; PK = `document_id`); the chosen `Alfred/`\* label id is persisted on `applied_label_id`.

Initial-sync seed: the OAuth callback (`google-routes.ts /callback`) enqueues a `gmail.ingest_recent` job with `maxMessages: 8, triageInsertedDocs: true` so a brand-new account has classified mail to look at immediately. The flag is the opt-in that narrows ADR-0025's "no triage on bulk re-ingest" rule — only callers that explicitly request triage get it. Re-connect is idempotent (dedup index → 0 inserts → 0 triage runs).

Re-classification on reply happens implicitly: every new message in a thread is its own document and gets its own triage run. We never sweep the whole thread.

Label management (`packages/integrations/src/google/labels.ts`):

- `ensureAlfredLabels(credentialId)` idempotently creates the six labels and caches the id map on `integration_credentials.metadata.alfredLabels`. Pass `force: true` to rebuild if a label was deleted out-of-band.
- `applyTriageLabel({ credentialId, messageId, category, previousLabelId })` adds the chosen label and removes the previous one (when supplied) in a single Gmail round-trip.

Smoke: `pnpm --filter server tsx --env-file=.env src/scripts/smoke-triage.ts` (requires a connected Google account + at least one ingested email).

## Morning briefing (m10)

Per ADR-0025 #2 alfred sends a daily inbox-only digest email built from triage tags. Calendar + "relevant updates" sections are deferred to a follow-up milestone.

The pipeline:

1. `briefing.tick` (BullMQ cron, hourly) scans users; for each, resolves `briefing.timezone` + `briefing.delivery_hour` from `user_preferences` (fallback chain: pref row → `UTC` + `7`) and enqueues a `morning-briefing` agent run when the user's local hour matches.
2. The `morning-briefing` workflow (`apps/server/src/builtins/workflows/morning-briefing.ts`) runs `gather` → `compose` → `send`:
   - `gather` queries `email_triage` joined to `documents` for the last 24h, partitioning into `action_needed` / `awaiting_reply` / `meeting` / `payment` priority buckets and counting `newsletter` / `fyi` for the suppressed-counts tail line.
   - `compose` renders a deterministic HTML+text email (no LLM call — the classifier rationales already carry the per-item gloss).
   - `send` calls `notify()` with idempotency key `briefing:{userId}:{YYYY-MM-DD-in-user-tz}`.
3. `notify()` (`packages/api/src/modules/notifications/`) writes an `email_sends` row at `status='queued'`, POSTs to Resend, then transitions to `'sent'` (with provider id) or `'failed'`. The `(user_id, idempotency_key)` unique index is what makes a duplicate cron tick a no-op.

OAuth scope refactor that landed alongside m10:

- `packages/integrations/src/google/oauth.ts` exposes `GOOGLE_FEATURE_SCOPES` (`briefing` / `triage` / `reply_draft`) + `scopesForFeatures(features?)`. `DEFAULT_GOOGLE_SCOPES` is now `scopesForFeatures()` — equivalent to "every feature."
- `/api/integrations/google/connect?features=briefing,triage` narrows the consent screen; default (no param) keeps the m7 single-prompt behavior.
- `requireScopes(credentialId, features[])` from `@alfred/integrations/google` throws `MissingScopesError` (typed `code: 'MISSING_SCOPES'`) when a credential drifted; workflows that hit Gmail directly should call this. Briefing reads from local DB only and skips it.

Smoke: `pnpm --filter server tsx --env-file=.env src/scripts/smoke-briefing.ts` (forces a send for the first user, ignoring the tz/hour gate; verifies idempotent re-run).

## Cold-start research (m11)

Per ADR-0011 + ADR-0022 alfred runs one Perplexity Sonar Deep Research call per user at signup, extracts structured `user_facts` proposals from the result, and stores the freeform research as a `memory_chunks` row for later semantic recall. Lifetime-once per user.

The pipeline:

1. The Google OAuth callback (`google-routes.ts /callback`) calls `createRun({ workflowSlug: COLD_START_WORKFLOW_SLUG, … })` + `enqueueRun(runId)`. The workflow declares `dedupKey: () => 'cold-start'`, and the partial unique index `agent_runs_dedup_key_idx` on `(user_id, workflow_slug, dedup_key) WHERE dedup_key IS NOT NULL AND status NOT IN ('failed','cancelled')` is the authoritative gate — a duplicate insert (re-connect, second tab) trips Postgres `23505`, which the callback catches and logs. Other failures are also logged but don't bounce the user back to an error page.
2. The `cold-start-research` workflow (`apps/server/src/builtins/workflows/cold-start-research.ts`) runs `gather-signals` → `research` → `extract-facts` → `persist`:
   - `gather-signals` calls `collectColdStartSignals(userId)` — reads the `user` row + connected `integration_credentials` per provider, ordered by `created_at` ASC so multi-account users get a deterministic anchor. v1 contributes `{ name, email, emailDomain, emailDomainIsConsumer, integrations.google? }`.
   - `research` calls `researchUser({ signals })` — one `meteredGenerateText` call against `getResearchModel()` (Perplexity `sonar-deep-research`) with `attribution.kind = 'web_search'`. 30–120s; returns prose + extracted citations. The forwarded `idempotencyKey` is stable per-run (`cold-start.research:${runId}`) — Sonar has no idempotency-key API, so this is observability metadata only; a worker-crash retry will re-bill.
   - `extract-facts` calls `extractColdStartFacts({ signals, research })` — cheap-tier (`getCheapModel()` + `meteredGenerateObject`) converts research prose into structured `{ key, value, confidence, rationale }` proposals.
   - `persist` calls `proposeFact()` per proposal (auto-confirm at confidence ≥0.85 per ADR-0019; existing rejection + active-dup guards apply) and `writeMemoryChunk({ kind: 'cold_start_research', … })` for the research summary. Embedding lands via the existing memory embed-sweep.
3. Cost lands as one `web_search` row + one cheap-tier `llm` row in `api_call_log`, attributable to the run via `(run_id, step_id)`.

Trigger semantics:

- The OAuth callback is the trigger because Google is currently the only integration that contributes signals beyond the user row. When more integrations land (GitHub, …), the trigger should move to whatever signal indicates "onboarding finished" — probably an explicit `cold-start ready` event once an onboarding flow exists.
- Lifetime-once is enforced by the unique index — there is no input-level `force` toggle. Letting `force` be caller-controlled would let any authenticated user spam expensive Sonar runs through `/api/agent/runs`. To re-research a user (future settings button, smoke script), cancel the prior `agent_runs` row first so the new insert clears the partial index.

Smoke: `pnpm --filter server tsx --env-file=.env src/scripts/smoke-cold-start.ts` (cancels any prior cold-start run for the first user, then forces a fresh one; verifies the research → extract → persist pipeline lands a `memory_chunks` row plus zero-or-more `user_facts` proposals tagged `source.kind='cold_start'`). Requires `PERPLEXITY_API_KEY`.

## Replicache

`packages/sync` ships the client-side mutators (currently `noteCreate`) and shared key helpers. Server-side push/pull/poke endpoints live at `/api/replicache/{push,pull,events}` (see `packages/api/src/modules/replicache/`). Pokes flow over Redis Pub/Sub on `replicache-pokes:u:<userId>` channels and reach the browser via SSE.

When adding a new synced entity:

1. Add an entry to `IDB_KEY` in `packages/sync/src/keys.ts` — one function that returns the prefix when called with `{}` and a single-row key when called with `{ id }`. The slug here drives every generic dispatcher downstream.
2. Define the read shape in `packages/sync/src/types.ts` (must include `rowVersion: number`).
3. Add `<entity><Action>Client` mutator + zod arg schema in `packages/sync/src/mutators/<entity>.ts`, register both in `mutators/index.ts` (`clientMutators` + `mutatorArgsSchemas`).
4. Add the matching server-side mutator in `packages/api/src/modules/replicache/server-mutators.ts` — write against the supplied `tx` (so it commits inside the push handler's outer transaction) and bump `row_version`. Pokes fire generically from the push handler after commit.
5. Add a fetcher to `ENTITY_FETCHERS` in `packages/api/src/modules/replicache/pull.ts` returning `{ id, rowVersion, serialized }` per row. The CVR snapshot shape (`Partial<Record<IDBKeys, ClientViewMap>>`) is generic — no `cvr.ts` change needed.

## Environment variables

Validated by `serverEnv()` from `@alfred/env/server`. Calling it with missing vars throws a clear error listing what's missing.

Key vars for local dev should be pre-filled in `apps/server/.env`

Some vars are optional and safe to leave blank locally.

When adding a new env var: update `packages/env/src/server.ts`, `apps/server/.env`, `.env.example`, and this file.

Do not use `process.env` directly in app code — always go through `serverEnv()`.

## Milestone status

- 1 — Scaffold
- 2 — Auth + first Railway deploy
- 3 — Replicache MVP
- 4 — Realtime stack (outbox → Redis → SSE)
- 5 — Durable agent runtime
- 6 — Cost metering
- 7 — Gmail integration end-to-end (7a OAuth+raw ingest, 7b embeddings+search, 7c poll+webhook code; webhook activation deferred — see [pending-setup.md](./pending-setup.md))
- 8 — Memory primitives
- 9 — Email triage workflow (9a schema + Gmail label plumbing, 9b classifier + workflow, 9c trigger from poll_history, 9d smoke-triage)
- 10 — Morning briefing workflow (10-pre per-feature scope sets + requireScopes; 10a email_sends + notify(); 10b morning-briefing workflow; 10c hourly briefing.tick + tz resolution; 10d smoke-briefing). Inbox-only at v1; calendar deferred.
- 11 — Cold-start research at signup (11a `getResearchModel()` + Perplexity Sonar Deep Research wired through `meteredGenerateText` with `kind='web_search'`; 11b `packages/api/src/modules/cold-start/` — signal collector, research call, cheap-tier extractor, dedup; 11c `cold-start-research` builtin workflow with steps `gather-signals` → `research` → `extract-facts` → `persist`; 11d trigger from `google-routes.ts` `/callback` gated by `hasPriorColdStartRun` so a re-connect doesn't re-run; 11e `smoke-cold-start.ts`). Signals are extensible per-integration — Google contributes `accountEmail` today; future GitHub/etc. integrations plug into `collectColdStartSignals` without workflow change. v1 trigger fires from the OAuth callback because Google is currently the only integration that contributes signals beyond the user row; revisit once another integration lands.
- 12 — Skills + user-authored workflows (authoring surface only; execution deferred to m13 per ADR-0017 + ADR-0027). Skills half already shipped earlier (schema, learn-skill + skill-documentation workflows, `/skills` UI, Replicache sync). Workflows half: **12a** workflows CRUD API (`packages/api/src/modules/workflows/`; builtins immutable except `status`; writes to `steps` rejected with "explicit DAGs land in a later milestone"); **12b** `/workflows` list + `/workflows/$slug` brief editor matching the dimension authoring shell (Plan / History / Approvals tabs, Schedule segment lit, Triggers segment disabled with "lands with m13" tooltip, Auto-approve toggle as inverse of `hil_gates`, Activate flips `status`); **12c** Replicache sync (`SyncedWorkflow`, `IDB_KEY.WORKFLOW`, fetcher, server mutators); **12d** trigger dispatch per ADR-0027 — adds `workflows.next_run_at` + `workflows.last_scheduled_at` columns + partial index, `agent_runs.trigger` jsonb column, generic `workflows.tick` handler running every minute using `cron-parser` at write-time (recompute `next_run_at` on row mutation and after each fire), BullMQ-jobId idempotency (`workflow:{id}:scheduled:{nextRunAtIso}`), unified `createRun({ trigger: { kind, scheduledFor?, eventId?, payload? } })` primitive (existing call-sites migrate from `metadata.triggeredBy` to `trigger`); `manual` trigger as a "Run now" button → direct `createRun({ trigger: { kind: 'manual' } })`; `event`/`on_signal` dispatchers deferred to m13 (the union supports them, no router yet); **12e** settings page unified active↔paused toggle for builtins + user-authored (closes the m9 deferral). **Execution stub**: `createRun` for `is_builtin=false` workflows lands as `failed` with reason `user_authored_brief_execution_pending_m13`. History tab on the workflow detail page shows those rows honestly. m13 replaces the stub.
- 13 — Boss + sub-agent orchestration. Replaces m12's execution stub. Builds the tool registry + tool dispatcher + `load_integration` + `AlfredAgent`→runtime bridge + sub-agent spawning + `event`/`on_signal` dispatchers all in one pass (ADRs 0016, 0026).
- 14 — MCP client
- 15 — Observability
