# Alfred — Architectural Decisions

A running record of design decisions made while scoping alfred (a personal-assistant agent in the spirit of dimension.dev). Each entry: the choice, the rationale, alternatives considered, and any caveats.

Companion doc: `dimension-dev-recon.md` (research on dimension.dev's architecture, used as a reference point throughout).

---

## Snapshot

| Layer                 | Choice                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Monorepo              | pnpm + Turborepo                                                                                                  |
| Runtime               | Node                                                                                                              |
| Server                | Elysia (Eden typed client)                                                                                        |
| Web                   | Vite + TanStack Router (SPA)                                                                                      |
| DB                    | Railway-managed Postgres + pgvector                                                                               |
| Cache/Queue/Pub-Sub   | Railway-managed Redis (BullMQ + Pub/Sub)                                                                          |
| Sync                  | Replicache (single-user, multi-device)                                                                            |
| Realtime              | Postgres outbox → Redis Pub/Sub → Elysia SSE                                                                      |
| Jobs/Cron             | BullMQ                                                                                                            |
| Agent runtime         | Roll-your-own durable execution (Drizzle checkpoints)                                                             |
| LLM SDK               | Vercel AI SDK                                                                                                     |
| Auth                  | Better Auth (magic link + passkey, one-email allowlist)                                                           |
| Hosting               | Railway                                                                                                           |
| Data access           | Hybrid (ingest + live)                                                                                            |
| Memory                | Structured tables + pgvector                                                                                      |
| Style                 | Dedicated table, channel × audience-bucket keyed                                                                  |
| Deploy safety         | Durable-resume with idempotent steps                                                                              |
| Cost metering         | `metered()` helper + flat log + DB-backed price table                                                             |
| Orchestration         | Boss + namespaced scratchpad: sub-agents auto-write `scratch.{sub_id}.*`, boss promotes to `shared.*`             |
| Skills                | Markdown docs with optional frontmatter; activated via `@skill:slug`                                              |
| Workflows             | Trigger + brief + optional explicit step DAG; mostly brief-only                                                   |
| MCP                   | Client-side only (consume external MCP servers); server-side deferred                                             |
| Memory correction     | In-app cards + chat-extraction; confidence-tiered auto-confirm; cron + end-of-thread + event-triggered extraction |
| Notifications         | Email only at v1 (Resend); morning briefing is the email itself; push/Slack/SMS deferred                          |
| Embedding             | Voyage family (voyage-context-3 ingestion, voyage-3.5 query) at 1024 dim, cosine, HNSW; Gemini fallback           |
| Web search            | Perplexity Sonar Pro (live agent tool); Perplexity Sonar Deep Research (cold-start onboarding)                    |
| Observability         | Sentry (errors) + PostHog (product analytics) + Langfuse (agent traces) — all on free tiers                       |
| Integration freshness | Webhooks where available + polling fallback (per-integration policy table in ADR-0024)                            |
| Built-in features     | 7 background workflows shipped with the app (ADR-0025); user-authored workflows alongside                         |
| Workflow trigger dispatch | Generic `workflows.tick` + denormalized `next_run_at` + unified `trigger` on `agent_runs` (ADR-0027)          |
| Composer voice input  | Browser-native `SpeechRecognition` (Web Speech API); no server STT (ADR-0028)                                     |
| Composer model picker | Opaque tiers (`Default` / `Pro`); never raw provider/SKU names (ADR-0029)                                         |
| Composer `+` menu / Tab autocomplete | Decoration-only in m12; behavior lands post-m13 (ADR-0030)                                         |
| People research       | Explicit, citation-grounded person dossiers; review before durable memory writes (ADR-0031)                       |

---

## ADR-0001 — User scope: single user with multi-device sync

**Decision.** Alfred is single-user (just me) but supports multi-device sync via Replicache. Auth still gates access.

**Why.** Personal-assistant features (calendar, email, phone) are nonsensical without an implicit "me." Multi-tenant adds tables, UI, and permission machinery for a use case that doesn't exist. Adding `org_id` later is cheap; ripping it out is not. Multi-device matters because the assistant must work on phone + laptop interchangeably.

**Alternatives.** Multi-tenant SaaS (rejected — no real users, all overhead). Local-only single-machine (rejected — kills the "always with me" property of an assistant).

---

## ADR-0002 — Package manager and runtime: pnpm + Node

**Decision.** pnpm workspaces + Node runtime, mirroring milkpod's scaffolding.

**Why.** Replicache is the riskiest moving piece, and milkpod is in the middle of validating it on this exact stack — borrow the pattern that's about to be battle-tested. AI SDK + BullMQ + Better Auth all have well-trodden Node deployment paths. The package boundaries hide the runtime, so migrating to Bun later is feasible if it ever pays off.

**Alternatives.** Bun (orys's choice — rejected for the dual-debugging cost on a project that already has unproven sync infra). pnpm + Bun runtime hybrid (rejected — Bun's pnpm support has rough edges).

---

## ADR-0003 — Web framework: Vite + TanStack Router

**Decision.** Pure SPA with Vite + TanStack Router for `apps/web`.

**Why.** App Router has real dev-compile pain on medium codebases; Pages Router still pays SSR-and-bundling costs the SPA shape doesn't benefit from. Personal assistant is a single authenticated app behind a login — no SEO, no static pre-rendering, no RSC payoff. Vite's HMR is dramatically faster than either Next router; TanStack Router gives typesafe routes; OAuth/integration callbacks belong on `apps/server` (Elysia) anyway, removing Next's last advantage.

**Alternatives.** Next.js Pages Router (rejected — still does SSR, in maintenance mode). Next.js App Router (rejected — dev compile pain, no RSC need).

---

## ADR-0004 — "Calling" scope: tool/function calling only

**Decision.** No voice mode, no phone calls. Just LLM tool/function calling via AI SDK.

**Why.** Voice and phone agents add real-time-audio infra (LiveKit/Pipecat/Vapi/Twilio) that's out of scope for V1 and not on the critical path for the dimension-style assistant pattern.

**Alternatives.** Voice mode (deferred — LiveKit Agents would be the path if revisited). Phone calling (deferred).

---

## ADR-0005 — Realtime layer: outbox + Redis Pub/Sub + Elysia SSE

**Decision.** Mutators write domain rows + an `events_outbox` row in one transaction. A relay worker (woken via Postgres LISTEN/NOTIFY internally) reads new outbox events and publishes to Redis Pub/Sub channels keyed `user:{id}`. Elysia exposes per-user SSE endpoints that subscribe to the relevant channel and push events to the client. Replicache pokes are one event type; agent progress, tool-call updates, and approval requests are others.

**Why.**

- **Outbox** gives transactional consistency: domain writes and event fan-out can't drift.
- **Redis Pub/Sub** is broadcast (every server instance sees every event → fans to its own SSE clients), which matches multi-instance fan-out semantics. Streams would duplicate the durability layer without buying delivery guarantees that browsers can't enforce anyway.
- **SSE** is dead-simple, integrates with AI SDK's existing streaming, and works behind any HTTP proxy.
- **Redis is in-stack already** (BullMQ), so Pub/Sub costs zero new dependencies.
- **PG LISTEN/NOTIFY** stays in its blessed niche: internal trigger that wakes the relay. Not used for client delivery.

**Alternatives.**

- Ably (rejected — external paid vendor for a fan-out problem we don't have at our scale; mirroring dimension on this layer is cosmetic).
- Bare LISTEN/NOTIFY → SSE (rejected — breaks at multi-instance, weaker resume narrative).
- Redis Streams (rejected — duplicates outbox durability, awkward broadcast semantics).
- Self-hosted WebSocket (rejected — bidirectional capability not needed; Eden RPC handles client→server).

**Caveat.** End-to-end "delivery guarantees" to a browser are impossible (no app-level ack); reconnect logic must always assume some events were missed and resync via Replicache pull or a `since_ts` outbox replay endpoint.

---

## ADR-0006 — Agent runtime: roll-your-own durable execution

**Decision.** Build a small durable agent runtime in TypeScript: state table in Drizzle, step function (`runStep(state) → nextState | interrupt | done`), worker loop driven by BullMQ, `interrupt()` primitive for HIL pauses. AI SDK is called inside steps; tool definitions are AI-SDK-native.

**Why.**

- LangGraph TS is a port that lags Python; bug-fix and ecosystem latency. Dimension uses Python LangGraph — mirroring it on the TS side gets you the _name_ not the substance.
- Polyglot (TS + Python LangGraph service) is a tax for one developer: two languages, two deploys, RPC boundary.
- Mastra is fine but opinionated; rolling the runtime ourselves is ~500 LOC for the patterns we actually need (checkpoints, interrupts, idempotent steps), and keeps the entire stack typed end-to-end via AI SDK + Eden + Drizzle.
- The architectural pattern (durable execution with checkpoint-based HIL interrupts) is the resume signal, not the package name.

**Alternatives.**

- LangGraph TS + AI SDK in nodes (rejected — fights message-format mismatch and TS-port maturity).
- Mastra (rejected — opinionated, less stack-coherent than rolling our own).
- Inngest / Trigger.dev / Hatchet (rejected — managed vendor coupling, less control over agent graph).
- Polyglot Python LangGraph (rejected — two-runtime tax for one developer).

---

## ADR-0007 — Hosting: Railway (one platform for everything)

**Decision.** Railway hosts `apps/server`, `apps/web` (static build), Postgres, and Redis as managed services on private networking.

**Why.**

- Long-lived SSE + BullMQ workers + cron jobs need always-on processes; serverless (Vercel/Cloudflare Workers) doesn't fit.
- Railway's managed Postgres + Redis with auto-injected `DATABASE_URL` / `REDIS_URL` is one-dashboard ops for a solo dev.
- Predictable flat-ish pricing (~$10–20/mo total at personal scale).
- GitHub-push deploys, multi-environment branches if needed, private networking between services.
- Already familiar from milkpod.

**Alternatives.**

- Single VPS (rejected — burns time on Postgres backups, Redis persistence, TLS, OS updates).
- Fly.io (rejected — Railway has flatter ergonomics for solo dev).
- Home server / Tailscale (rejected — home-internet flakiness, missed scheduled briefings if machine sleeps).
- Vercel + separate server (rejected — no upside for an authenticated SPA, more dashboards to babysit).

---

## ADR-0008 — Database: Railway-managed Postgres with pgvector

**Decision.** Single Postgres instance on Railway, pgvector extension enabled, holds domain data + Replicache state + memory + vector embeddings.

**Why.**

- Alfred's load is constant background workers + cron + vector queries — Neon's per-second-compute billing turns expensive fast in this profile (workers keep compute warm 24/7).
- Co-located with `apps/server` on Railway's private network → sub-ms query latency, zero egress.
- pgvector handles personal-scale vector search (≪ 10M chunks) trivially, with the bonus of joining to other tables (`chats ↔ chunks ↔ documents`).
- Single dashboard, single backup story, single migration tool (Drizzle Kit).

**Alternatives.**

- Neon (rejected — compute billing punishes constant background workload).
- Supabase (rejected — useful if we wanted their auth/storage, but we have Better Auth and we don't need their other primitives yet).
- TurboPuffer for vectors specifically (rejected — designed for many-tenant, billions-of-vectors economics; alfred is one tenant; transactional joins to Postgres tables are more valuable than TP's serverless cold-namespace cost advantage).

---

## ADR-0009 — Auth: Better Auth + magic link + passkey + allowlist

**Decision.** Better Auth with both email-magic-link and passkey enabled. A signup hook enforces a one-email allowlist (env var). Same shape as `@milkpod/auth`.

**Why.**

- Direct copy from milkpod scaffolding — fastest path to a working auth surface.
- Passkeys give one-tap login on every registered device.
- Magic-link / OTP is the recovery path if a passkey is lost.
- Allowlist is a one-line guard, removable in one commit when graduating to multi-user.
- Better Auth gives us the user session that integration OAuth callbacks attach to. Integration tokens (Gmail/Slack/etc) are stored in their own per-user `integration_credentials` table — separate from auth.

**Implementation note (2026-04-27).** Milestone-1 scaffolding shipped with **emailOTP only**, not passkey. better-auth@1.6.9 (latest within milkpod's catalog `^1.3.28` range) does not export `./plugins/passkey` from its package — the plugin appears to have been removed from the main package mid-reorganization, with no clear replacement yet (no `@better-auth/passkey` peer package on the registry as of writing). Passkey is **deferred** until either (a) better-auth's plugin layout stabilizes and exposes passkey again, or (b) we wire `@simplewebauthn/server` directly. emailOTP satisfies the "real auth flow, not bearer token" intent of this ADR for v1.

**Alternatives.**

- Passkey-only (rejected — no recovery path).
- Env-based bearer token (rejected — weak resume signal, no graduation story, doesn't compose with OAuth integration callbacks).
- Edge auth via Cloudflare Access / Tailscale Funnel (rejected — doesn't compose with external OAuth callbacks).

---

## ADR-0010 — Data access pattern: hybrid (ingest + live)

**Decision.** Per-integration policy split between background ingestion (writes into Postgres + pgvector, supports semantic search and morning-briefing reads) and live API calls (current state, low-staleness operations, posting actions).

**Per-integration starting policy:**

- **Gmail** — ingest body + headers + threads; live-poll the last 24hr for freshness; live-call to send.
- **Calendar** — live-only (small payload, must be fresh).
- **Docs** — ingest content; live-call to read a specific doc by ID.
- **Slack** — ingest opted-in channels; live-call to post.
- **Linear / GitHub** — live-only (small payloads, real-time status matters).
- **iMessage** — ingest only (no live API; sourced from local export).

**Why.**

- Live-only kills morning-briefing UX (each turn becomes 50 API calls; agent context blows up).
- Ingest-only breaks correctness (calendar must reflect a change made 5 min ago).
- Per-integration policy is natural and matches dimension's `warmIntegrationNamespaces` + live-RPC split.

**Alternatives.** Live-only (rejected — no semantic history, no offline reasoning). Ingest-everything (rejected — stale calendar within a week).

**Implementation shape.** `packages/integrations/<provider>/` exports `oauthFlow`, `liveTools`, `ingestor`, `webhookHandler`. `packages/ingestion/` holds shared chunker, embedder, dedup, vector-write helpers. One `documents` + `chunks` schema, source-tagged, vector column on chunks.

---

## ADR-0011 — Cold-start research at signup

**Decision.** On signup, kick off a `cold_start_research` BullMQ job. Inputs: email, optional GitHub username, work-email domain. Sources:

- Web search (Exa.ai, Tavily, or Linkup — TBD; Tavily/Linkup stronger for entity-research).
- Email domain → company info (Crunchbase / website / LinkedIn page).
- Public GitHub commits/repos/orgs.
- Personal site (often discoverable).
- Public social handles (Twitter/Bluesky/Mastodon).

Outputs land in the memory layer: `user_facts` rows with `confidence`, `source`, `status='proposed'` for user confirmation; freeform research summary indexed in `memory_chunks`.

**Why.** Lets alfred bootstrap with non-zero context before any integrations are connected. Mirrors dimension's onboarding research per Ronit's blog.

**Alternatives.** Cold-start from zero (rejected — empty assistant for first weeks).

**Open.** Web search provider choice deferred (Exa vs Tavily vs Linkup).

---

## ADR-0012 — Memory architecture: structured tables + pgvector

**Decision.** Memory is a small set of opinionated tables in Postgres:

- `user_facts` — typed key/value with `confidence`, `source`, `status` (proposed/confirmed/rejected/superseded), `valid_from`/`valid_until`, `supersedes_id`.
- `user_preferences` — tone, response length, content filters, tool-default knobs.
- `style_profiles` — see ADR-0013.
- `entities` + `entity_relations` — lightweight in-DB graph (recursive CTEs for traversal at this scale).
- `memory_chunks` — pgvector for semantic recall over freeform conversation summaries.

**Why.**

- Single-user economics demolish Zep+Neo4j: graph DB ops cost for a graph that fits in 10MB.
- Most queries alfred needs are 80% structured key-lookup, 15% semantic recall, 5% multi-hop. Tables nail the first two.
- **Correction loop is trivial**: alfred infers a fact → row with `status='proposed'` → Replicache syncs → user accepts/rejects/edits → status changes. The full UX is just rows.
- **Provenance is first-class.** Each fact links to its source (`email_id`, `chat_message_id`, `tool_call_id`). User can ask "why do you think my manager is Alice?" and see the source.
- **Temporal facts** via `valid_from`/`valid_until` + `supersedes_id` (replicates Zep's temporal-edge feature in SQL).
- **Graceful upgrade**: if multi-hop ever matters at scale, swap `entities` + `entity_relations` for a real graph DB; interfaces don't change.

**Alternatives.**

- Zep + Neo4j (rejected — single-user economics, fuzzy correction model, weaker provenance).
- Vector-only with summary docs (rejected — "who is my manager" should be a row lookup, not a fuzzy similarity search).

---

## ADR-0013 — Style profiles: dedicated table, channel × audience keyed

**Decision.** Dedicated `style_profiles` table. Each row = `(channel, audience_bucket, optional recipient_id) → profile_doc + few-shot examples + provenance`. Lazy materialization: generic-per-channel profiles seed at signup; narrower profiles generated in background on first need.

```
style_profiles
  id, user_id
  channel              enum(gmail, imessage, slack, doc, code_review, twitter, generic)
  audience_bucket      enum(family, friend, peer, manager, customer, vendor, public, generic)
  recipient_id         nullable      -- specific person if narrower than bucket
  profile_doc          text          -- LLM-readable style guide
  examples             jsonb         -- 3-5 representative samples
  source_msg_ids       jsonb         -- provenance into chunks/messages
  generated_at         timestamp
  generated_from_count int
  confidence           float
  status               enum(draft, active, superseded)
  superseded_by        uuid?

  unique(user_id, channel, audience_bucket, recipient_id)
```

**At draft-time:** look up most-specific applicable profile (`recipient_id` > `audience_bucket` > `channel-generic`). Multi-channel drafts (e.g., post to Slack and Gmail simultaneously) generate one draft per target with each target's own profile in the prompt — never merge two profiles.

**Why both `profile_doc` and `examples`:** doc tells the LLM _what_ the style is in words; few-shot examples in the prompt outperform a written guide for actual style transfer. Use both: doc as instructions, examples as evidence.

**Audience-bucket assignment** comes from `user_facts` (alfred infers `relationship:alice@… = manager` from signatures, calendar invites, message patterns). User correction updates the fact, which changes the profile lookup.

**Privacy / regen rules.** Profile rows store `source_msg_ids`, not corpus content. When user deletes a source message, profiles citing it get `regenerate_needed`. Profiles must opt out of citing alfred-generated drafts (avoid circularity). Distilled profile + RAG examples replaces both fine-tuning (privacy risk: corpus leaves to OpenAI/Anthropic) and full-corpus per-call RAG (cost + variability).

**Alternatives.**

- One global profile doc (rejected — formal-Gmail vs casual-iMessage contradict each other).
- Pre-fill all `(channel × audience)` combos (rejected — combinatorial blow-up, mostly empty rows).
- Fine-tune a model on corpus (rejected — privacy + drift + cost).
- Per-call full-corpus RAG (rejected — every draft pays retrieval cost; doc + examples is cheaper and deterministic).

---

## ADR-0014 — Deploy safety: durable-resume with idempotent steps

**Decision.** Background agents and BullMQ workers use a durable-resume model. State persists to Postgres after each step. On graceful shutdown (SIGTERM), workers finish the current step (with timeout), mark inflight runs as `interrupted_at_checkpoint`, and exit. New version starts → polls for interrupted runs → resumes from last checkpoint. Every step is idempotent.

**Mechanisms required.**

- **Idempotency keys** per step: derived from `(run_id, step_id, attempt_id)`; passed to LLM/Gmail/Slack/etc; providers dedupe.
- **Action staging for outbound effects**: don't `slack.postMessage` inside a step; _plan_ a `SlackPost` row and commit the plan in the same tx. A separate worker reads pending plans and executes with idempotency.
- **Step boundaries chosen for durability**: a long token-streaming step is safe to lose and re-run; a multi-tool-plan step commits each tool plan as it goes.
- **Graceful shutdown** wired into the Railway service.

**Why.**

- Drain-and-deploy is unworkable when HIL means a run might pause for hours waiting for user approval; you'd never ship while anything's mid-task.
- Pinned-version workers (multi-version coexistence) require k8s/Nomad-style orchestration and backward-compat schemas — stratospheric overkill for one user.
- Idempotency is good design hygiene anyway: every external write needs an idempotency key for retries and crashes regardless. Durable-resume just makes it the default model.

**Alternatives.**

- Drain-and-deploy (rejected — blocks deploys behind in-flight HIL runs).
- Pinned versions (rejected — multi-version k8s overkill at this scale; concretely, a run paused on HIL for 3 days during a v1.4.2→v1.4.5 release cadence would force four parallel worker pools alive simultaneously, with backward-compat schema across all of them, and graveyard cleanup as permanent ops work).

---

## ADR-0015 — Cost / token metering

**Decision.** Every billable external call (LLM, embedding, web search, transcription, tool-API) flows through a single `metered<T>(meta, () => Promise<T>): Promise<T>` helper. The helper writes a row to a flat `api_call_log` and computes `cost_usd` from a DB-backed `model_prices` table at write-time (snapshot, not recomputed retroactively). Aggregates (`cost_per_message`, `cost_per_run`, `cost_per_day`, `cost_per_skill`) come from materialized views or scheduled rollups, not pre-aggregated counters.

**Schema sketch.**

```
api_call_log
  id, created_at
  kind                enum(llm, embedding, web_search, transcription, tool_api, ...)
  provider, model
  input_tokens, output_tokens, cached_input_tokens
  cost_usd            numeric(12,8)   -- snapshot computed at write time
  latency_ms
  run_id, step_id, message_id, user_id   -- attribution chain (nullable)
  request_meta        jsonb           -- trimmed model params + attempt count
  response_meta       jsonb           -- finish_reason, usage, tool_calls count
  error               jsonb?

model_prices
  provider, model, valid_from, input_per_mtok, output_per_mtok, cached_input_per_mtok
```

**Implementation invariants ("pristinely").**

- **Single chokepoint** — all priced external calls go through `metered()`. Greppable for `metered(`. No bypass paths.
- **Async-safe** — logging never blocks the main path. Inline write on a separate connection (or bounded buffer + flush worker if Postgres ever struggles).
- **Failure-recording** — failed calls write rows too, with `error` populated and `cost_usd = 0` (or the partial cost if a stream consumed tokens before failing).
- **No double-counting** — one row per terminal success. SDK-internal retries are folded; attempt count goes in `request_meta`.
- **Strongly typed** — `metered<T>` preserves inner return type fully. No `any`.
- **Thin** — pure observation; no business logic, no payload transformation.
- **Idempotency-aware** — replays of the same `(run_id, step_id, attempt_id)` after crash recompute from SDK-cached responses; one row per successful unique attempt.

**Why flat log + rollups, not pre-aggregated counters.**

- Audit any single call without losing detail.
- Derive new aggregates later (per-skill, per-tool, per-integration) without schema migration.
- Postgres handles rollups trivially via materialized views or BullMQ-driven refresh.

**Why DB-backed `model_prices` with `valid_from`.**

- Price changes happen between deploys; price-table-as-code forces redeploy ceremony.
- Snapshotting `cost_usd` at write time means later price corrections never silently rewrite history.

**Alternatives.**

- Provider-wrapping (`meteredAnthropic = wrap(anthropic)`) — rejected; misses non-LLM costs (embeddings, search, transcription).
- OpenTelemetry spans + usage exporter — rejected for now; overkill, harder for in-app cost UIs. Could be layered on later for traces/latency without changing this design.
- Static TS price map — rejected; redeploy churn for a number that changes outside our release cadence.

---

## ADR-0016 — Multi-agent orchestration: boss + isolated sub-agents + boss-only-writes run-context

**Decision.** Boss/sub-agent topology with a **namespaced scratchpad**: sub-agents auto-write to their own `scratch.{sub_id}.*` zone (no extra LLM cost; runtime persists the return value), boss reads scratch and promotes selected entries to `shared.*` (canonical/validated). Concretely:

- Boss agent plans, decomposes a task, spawns N sub-agents (parallel or serial), aggregates results, replies.
- Sub-agents return a structured summary; the **dispatcher auto-writes that summary to `scratch.{sub_id}.summary`** (and any sub-keys the sub-agent emits) — no extra LLM call to "write."
- Sub-agents can **read** from both `scratch.*` and `shared.*` via brief snapshot, but can only **write** to their own `scratch.{sub_id}` zone (enforced at the dispatcher layer, not by the model).
- Boss reads scratch and either: (a) cheaply promotes via a `promote(scratch_key)` tool call — no content rewrite — or (b) does a synthesis pass that condenses multiple scratch entries into a unified `shared.*` entry. Promotion is the moment of validation.
- Hard limits: max 1 level of nesting (no sub-sub-agents), max 5 parallel sub-agents per spawn batch (tunable), per-sub-agent step + token caps. Hitting a limit returns a partial result + reason.
- HIL interrupts (ADR-0006/0014) work at any agent level; durable-resume picks up the paused run.

**Schema.**

```
agent_run_context
  run_id
  key             text     -- e.g. 'shared.user_facts', 'shared.entities.alice', 'scratch.sub_a.summary', 'scratch.sub_a.findings.x'
  value           jsonb
  zone            enum(shared, scratch)
  written_by      text     -- 'boss' for shared.*, '{sub_id}' for scratch.{sub_id}.*
  written_at      timestamp

  primary key (run_id, key)
```

Per-run, TTL ~7 days (post-completion) for audit/replay. Lives in Postgres next to run checkpoints; no Redis needed for this surface.

**Why namespaced scratchpad vs boss-only-writes vs free-form:**

- **vs boss-only-writes**: avoids paying expensive-model cost just to retype sub-agent outputs (the original critique). Sub-agents already produced summaries; runtime persists them for free.
- **vs free-form sub-agent writes anywhere**: namespace scoping prevents one sub-agent overwriting another's findings or corrupting canonical state.
- **Compound-error risk**: a downstream sub-agent reading `scratch.*` knows it's unvalidated and prompts treat it as advisory; `shared.*` is authoritative; boss is the gate that validates before promoting. Same correctness property, different cost shape.
- Still gets the dedup + cross-pollination wins: boss promotes finding from sub-agent A and spawns B/C/D that read `shared.alice = manager` directly.

**Why no Redis for this layer:** at single-user scale, Postgres handles per-run K/V trivially; it's already the home of checkpoints, outbox, and run state. Redis stays for BullMQ + Pub/Sub.

**Why max 1 level deep:** unbounded depth is unbounded cost + latency + debugging hell; tasks decompose to 1 level 95% of the time; if a sub-agent thinks it needs sub-sub-agents, that's a sign for the boss to re-plan.

**Model defaults (subject to prompt-engineering pass).**

- **Boss**: Sonnet 4.6 default; escalate to Opus 4.7 via explicit `escalate_model` tool, or auto-escalate on a complexity heuristic.
- **Sub-agent reasoning**: Sonnet 4.6.
- **Sub-agent extract/summarize/classify**: Haiku 4.5 or Gemini 2.5 Flash; dispatcher picks cheapest available based on capability tags + credentials.
- **Long-thread compaction**: cheap tier (Haiku 4.5 / Gemini 2.5 Flash).

**Capability tagging, not hardcoded models.** Each sub-agent kind specifies required capabilities (`{ minContextWindow, supportsToolCalls, costTier }`), dispatcher resolves to a concrete model from `model_prices` + credential availability. Anthropic + Google initially; OpenAI when keys are available; dispatcher silently skips unavailable providers.

**Source for model registry / pricing seed.** `models.dev` provides public model pricing + capabilities; `pnpm db:sync-prices` pulls + upserts into `model_prices` with today's `valid_from`.

**Alternatives.**

- (a) Single agent (rejected — context-window economics; 200K-token bloat from irrelevant tool results).
- (b1) Strictly isolated sub-agents with no shared context (rejected — forces serialized dependencies or duplicate-brief context).
- (b2-free-form) Free-form sub-agent-writes scratchpad with no scoping (rejected — race conditions, compound-error risk).
- (b-boss-only-writes) Boss-only-writes shared context (rejected — pays expensive-model cost to retype sub-agent outputs that the cheap sub-agent already produced).
- (b3) Direct inter-agent messaging (rejected — emergent coordination, hard to debug).
- (c) Hierarchical (rejected — unbounded depth/cost/latency; re-plan is the right primitive).
- (d) Workflow-graph only (rejected — loses the agent's value of choosing what to do at runtime; see ADR-0017 for how deterministic workflows still fit).
- (e) Actor model (rejected — cron + skills cover the persistent-agent pattern at our scale).

---

## ADR-0017 — Skills + workflows: skills are markdown, workflows are trigger + brief + optional step DAG

**Decision.**

**Skills are markdown documents** with optional frontmatter for structured metadata (tools, default model, examples, activation hints). The body is the skill content; the frontmatter is parsed for runtime use. Skills are activated explicitly via `@skill:slug` references in workflow briefs or chat messages — the runtime resolves the slug, injects `content_md` into the system prompt, and applies frontmatter constraints.

**Workflows are `trigger + brief + optional explicit steps DAG`**:

- If `steps` is null/empty → pure agent run with the brief; boss decomposes at runtime. Most user-authored workflows live here ("mail me job listings every Tuesday in @skill:westerosi-dialect").
- If `steps` is present → runtime executes deterministically; node types: `run_skill` / `tool_call` / `llm_call` / `agent_run` / `condition` / `parallel` / `loop` / `hil_approve`. For built-ins like morning-briefing where the structure is known and reliability matters.
- Hybrid permitted: deterministic outer DAG with `agent_run(brief)` nodes for parts that should be LLM-decided.

**Schema sketch.**

```
skills
  id, user_id, slug (unique per user), name, description
  content_md      text      -- skill body (markdown), authoritative
  metadata        jsonb     -- parsed frontmatter: { tools?, default_model?, activation_keywords?, examples? }
  status          enum(active, draft, archived)
  created_at, updated_at

workflows
  id, user_id, slug (unique per user), name, description
  trigger         jsonb     -- cron schedule | integration event filter
  brief           text      -- natural-language workflow brief
  steps           jsonb?    -- optional explicit DAG; null = brief-only agent run
  hil_gates       jsonb     -- which steps require approval (only meaningful with explicit steps)
  status          enum(active, draft, paused, archived)
  last_run_id, last_run_at, last_run_status
  created_at, updated_at

workflow_runs
  id, workflow_id, started_at, ended_at, status
  -- references the durable agent runtime checkpoints (ADR-0006)
```

**Why this shape.**

- **Skills as markdown** matches the Claude-Code/Cursor pattern; trivial authoring (the user can write a skill in a text editor or paste it into a form), trivial inspection, naturally version-controllable if we ever want skills as files in `apps/server/skills/*.md` for built-ins.
- **Skills don't need to be referenced** — workflow briefs can inline instructions directly. Skills are a _reusability_ primitive, not a required indirection.
- **Brief-only workflows** match the dominant user authoring pattern ("here's what I want, figure it out"). Explicit DAGs are reserved for cases where reliability or structure matters.
- **Workflows compile down to durable runtime steps** (ADR-0006). HIL gates become runtime interrupts. Skills inside workflows spawn child agent runs linked via `parent_run_id`.
- **The 8 background agents in dimension's pattern** become 8 workflows, each cron-triggered, each invoking 1-2 skills.

**Authoring UX (later).**

- Skills: form in the app for body + frontmatter; markdown editor.
- Workflows: brief field, optional step builder; visual graph view is polish, not v1.
- For built-in workflows/skills owned by alfred itself: code in the repo (`apps/server/builtins/skills/*.md`, `apps/server/builtins/workflows/*.ts`), seeded into the DB at deploy time; user-authored ones live in DB only.

**Alternatives.**

- (β) Skills as templates, workflows as agent runs (rejected — loses determinism for known-structure workflows like morning briefing).
- (γ) Both agent-shaped (rejected — same; loses user-trust primitive of "I can read my Tuesday workflow as a list of steps").
- (δ) Both graph-shaped (rejected — graph editor authoring surface is too heavy for a one-person tool; brief-based is simpler with same expressive power).

---

## ADR-0018 — MCP scope: client-side only at v1

**Decision.** Alfred is an **MCP client** at v1: it connects to external MCP servers configured per-user, imports their tool catalogs into its tool registry, and the agent invokes them like any native tool. Alfred-as-MCP-server (exposing alfred's own tools to other agents) is **deferred**.

**Schema sketch.**

```
mcp_servers
  id, user_id, name, url, transport (stdio/http/sse), auth_type, credentials_ref
  capability_cache jsonb        -- last-seen tool schemas
  trust_level      enum(trusted, sandboxed, blocked)
  last_connected_at, status enum(active, error, paused)

mcp_server_tools  -- materialized from capability_cache
  mcp_server_id, tool_name, schema jsonb
  primary key (mcp_server_id, tool_name)
```

**Tool naming.** External tools are namespaced as `mcp:{server_slug}:{tool_name}`. Skill frontmatter `tools` allowlist accepts both native (`gmail:*`) and MCP-sourced (`mcp:clickup-personal:*`) tools.

**Lifecycle.**

- Connect on server startup (and on add); list tools; cache schemas.
- Reconnect with backoff on disconnect.
- Tool calls forward through `metered()` (kind=`tool_api`) for cost attribution.

**Trust + safety.**

- `trust_level`: `trusted` invokes freely; `sandboxed` requires HIL approval per-call; `blocked` disabled.
- Sensitive actions (anything writing to external systems) go through the same staging/approval pipeline as native tools.

**Why MCP client now:**

- Massive tool extensibility without redeploys; community ecosystem at Smithery/mcp.so/registry.
- Same shape as native tools at the registry layer; agent can't tell the difference.
- Per-skill scoping via existing tool allowlist mechanism.
- Implementation is small: `@modelcontextprotocol/sdk` TS client + a tool registry + a metered router.

**Why MCP server deferred:**

- No clear consumer at v1 (would mainly be alfred-from-Claude-Desktop, niche).
- Real attack surface (any connecting agent gets alfred's tools).
- Cleanly addable later as a wrapper over `packages/api` tools.

---

## ADR-0019 — Memory correction loop UX

**Decision.**

**Input channels (v1):** in-app cards + in-chat extraction. Email-reply parsing deferred (brittle; structured emails with deep links to in-app are cleaner). Slack/iMessage corrections fold into chat-extraction once those transports connect.

**Lifecycle:** every `user_facts` row has `status ∈ {proposed, confirmed, rejected, edited, superseded}`. Confidence-tiered auto-confirm: facts with `confidence > 0.85` auto-confirm with a soft notification ("alfred learned: X" with undo); facts below stay `proposed` and require explicit accept. Edits create supersession chains via `supersedes_id`; full history retained. Rejections are first-class — a `rejected_inferences` table tracks pattern signatures so the extraction sub-agent doesn't re-propose them.

**Extraction triggers (all three):**

- **End-of-conversation** — after each chat thread closes, run a `memory_extraction` sub-agent over the transcript + current `user_facts` to propose deltas. Cheap-tier model.
- **Background cron (daily)** — bulk extraction over recent ingested integration data (sent emails, accepted invites, resolved tickets). The workhorse — most facts come from here.
- **Triggered (event-based)** — high-signal events (new contact added, first email exchange with new sender, new project signal) emit a `propose_facts` job.

**UX shape.**

- **Memory page** in the app: tabs for facts / preferences / style profiles. Cards show key, value, confidence, source link, timestamp, [✓ confirm] [✗ reject] [✎ edit]. Replicache-synced; filterable by status, source, recency.
- **Inline corrections in chat**: when alfred cites a fact ("I'll loop in Alice (your manager)"), it's a soft hyperlink to inspect/correct without breaking flow.
- **Auto-confirm notification**: non-modal toast with undo affordance.
- **No mid-task interrogation** — corrections are always async and batched, never interrupt a task.

**Extraction sub-agent invariants** (prompt-engineering pass — flagged, not designed here):

- Conservative-by-default; high confidence threshold for emitting.
- Awareness of `rejected_inferences` to avoid re-proposal.
- Zod-enforced output schema `(key, value, confidence, source_id, valid_from)`.
- Provenance discipline: every fact cites a specific `message_id` or `tool_call_id`; no hallucinated sources.

**Why confidence-tiered auto-confirm vs always-explicit-accept.**

- Always-explicit floods the user with "is this right?" cards for obvious facts (someone's email signature literally says "Alice, Engineering Manager") — friction without value.
- Always-auto erodes trust; user wants the gate for ambiguous inferences.
- Tiered captures both: friction for ambiguous, frictionless for obvious, undo as the safety net.

**Why email-reply parsing deferred.**

- Free-form reply parsing is brittle and ambiguity-prone.
- The "review" use case is better served by structured emails with a "review in app" deep link → routes back to the in-app card surface.

---

## ADR-0020 — Notifications: email only at v1

**Decision.** External notifications go through email only (Resend). Morning briefing _is_ an email — the medium, not just an alert about it. Push, Slack DM, SMS, and other channels are deferred to a future ADR; the data shape leaves them open.

**In-app realtime alerts** ("alfred learned X", "approval pending") are handled by the existing realtime stack (SSE + Replicache poke + ephemeral toast events) — these don't need email. External delivery only happens for things the user wants pushed _to_ them when not actively using alfred (briefings, urgent approvals, summary digests).

**Schema.**

```
notification_preferences
  user_id, kind enum(briefing, approval, learned_fact, integration_alert, ...)
  channels      jsonb     -- ordered list with per-kind config
                          -- v1: only ['email'] supported
                          -- future: ['web_push', 'slack_dm', 'sms', 'email']

email_sends
  id, user_id, kind, idempotency_key (unique), to, subject, template, payload, sent_at, status, provider_message_id
```

A central `notify(user_id, kind, payload)` consults preferences and fans out. v1: `channels` is always `['email']`; later additions are matchers, not breaking changes.

**Why email-only:**

- Auth magic-link already requires Resend in the dependency tree (`@milkpod/auth` pulls it); zero new infra.
- Universally reliable, available on every device, doesn't require PWA install.
- Email is _itself useful_ (archive, search, reply) for things like the morning briefing — it's not just a transport.
- Web Push needs service-worker + VAPID + push-subscription lifecycle; real engineering for a feature that's nice-to-have at v1.

**Why future-proof the schema anyway:** the `notification_preferences.channels` jsonb means adding `web_push` or `slack_dm` later is a config change + a new fan-out branch in `notify()`, not a schema migration.

**Alternatives.**

- Web Push primary (deferred — engineering cost not justified at v1).
- SMS via Twilio (deferred — paid; HIL approval may eventually justify it).
- Slack/Telegram DM (deferred — depends on Slack integration being live first).

---

## ADR-0021 — Embedding model

**Decision.** Voyage family as primary, Gemini text-embedding-005 as fallback (credential-gated).

- **Ingestion**: voyage-context-3 at 1024 dim — contextualized embeddings handle long-form emails/docs where chunk-in-isolation loses meaning.
- **Query-side**: voyage-3.5 at 1024 dim — cheaper, faster, plenty for short query strings.
- **Fallback**: gemini-embedding-001 / text-embedding-005 (768 dim, with separate index column if it ships) when Voyage credentials missing.
- **Index**: pgvector HNSW, cosine distance, `m=16, ef_construction=200, ef_search=80`. Tunable post-launch.
- **Reranker**: Voyage rerank-2.5-lite for hybrid search final stage (BM25 + vector + RRF + rerank, mirroring dimension's pattern).

**Why Voyage at 1024 dim:**

- Top-tier English retrieval quality on MTEB (per recent benchmarks); voyage-context-3 specifically wins on long-doc retrieval.
- Anthropic recommends Voyage as embedding partner — vendor-aligned with our LLM choice.
- 1024 dim is the model's native output; matches HNSW well; smaller index than 1536 with negligible recall loss at our scale.
- Pricing: ingestion at ~$3-9 lifetime cost for a 50M-token personal corpus.

**Why model name is pinned at implementation time, not in this ADR:** Voyage's lineup evolves (Ronit references "Voyage-4" which doesn't match the current public catalog as of writing); models.dev is the source of truth for current version + pricing. The decision is "Voyage family at 1024 dim with Gemini fallback," not a specific SKU.

**Single embedder module.** `packages/ai/embeddings.ts` hides model name + provider behind `embed(text, opts)`. Swapping families later is one-file change.

**Rotation plan** (future-proofing):

- Schema: `embedding_v2` column rather than altering `embedding`; backfill via BullMQ chunked job; flip read path; drop old.
- Don't write code that hardcodes "voyage" anywhere outside the embedder module.

**Alternatives.**

- OpenAI text-embedding-3-large at 3072 dim (rejected — credentials-gated; 3x index size for marginal recall gain).
- Cohere embed-v4 (rejected — thinner ecosystem, no clear win over Voyage at our scale).
- Local BGE / nomic-embed (rejected — Railway compute cost > Voyage spend; only justified if privacy-vs-Voyage matters and we already trust Anthropic with full-text content).

---

## ADR-0022 — Web search provider: Perplexity (Sonar Pro + Sonar Deep Research)

**Decision.** Perplexity for both web-search use cases. Two SKUs split by use case:

- **Cold-start research at signup** (ADR-0011) → **Sonar Deep Research**. Multi-step, multi-source synthesis with structured citations. Async via BullMQ; latency (30-90s) tolerable. ~$1-5/signup.
- **Live agent web-search tool** → **Sonar Pro**. Synthesized answers + citations in 2-5s. Available to boss/sub-agents/skills as a regular tool. Few-cents-per-day at personal scale.

Both flow through `metered()` (`kind=web_search`).

**Why Perplexity over Tavily/Exa/Brave/SerpAPI:**

- **Synthesis-shaped output** matches how agents actually consume search — answers + citations, not raw URL lists. Saves the fetch-extract-summarize pipeline.
- **Disambiguation reasoning** is materially better on hard queries (low-public-footprint name disambiguation, conflicting-context queries). Tavily test query for the user's name returned mostly noise (Bollywood actor confusion, unrelated PDFs); the failure mode is structural, not accidental.
- **Sonar Deep Research is the natural cold-start tool** — multi-step research-and-synthesize in one call, with citation discipline. Approximates what a human researcher would do over an hour.
- **Credentials already available**, removing one decision.

**Latency caveat.** Perplexity Sonar models add LLM-pass latency (2-5s for Sonar Pro, 30-90s for Deep Research) versus raw search APIs (sub-second). Agent prompts must reflect this — web search is _deliberate_, not _exploratory_. Cold-start research runs in BullMQ so users never see the latency.

**Alternatives.**

- Tavily (rejected after test — disambiguation poor on low-public-footprint names; requires extra synthesis layer for agent consumption).
- Exa (rejected — strong on "find similar pages" semantic search but weaker for entity research; could layer in later for that specific use case).
- Brave / SerpAPI (rejected — raw results force us to build extraction/scoring/dedup ourselves; Perplexity already does it).

---

## ADR-0023 — Observability: Sentry + PostHog + Langfuse

**Decision.** Three tools, three lanes, all on free tiers:

- **Sentry** — server + browser exception tracking, perf, breadcrumbs. SDK in `apps/server` and `apps/web`; init via `instrumentation.ts` (milkpod has the pattern). Replicache mutators wrapped to surface mutator errors.
- **PostHog** — product analytics. Page views + custom events from key flows (workflow run started, skill invoked, fact accepted/rejected, draft accepted, integration connected). Useful even at single-user scale to track which workflows actually get used.
- **Langfuse** — LLM agent tracing. Cloud free tier (50K observations/mo); self-host on Railway as an option later if agent-prompt content needs to stay in our infra. Visualizes agent run trees: boss → sub-agents → tool calls, with prompt/response per node.

**Wire-up.** `metered()` (ADR-0015) emits a Langfuse span alongside the DB log row. Parent-child relationships via `run_id` / `step_id` / sub-agent ids. One module, two side effects per billable call.

**Why three tools, not one:**

- Sentry is best-in-class at JS errors and perf; weak at structured agent traces.
- Langfuse is best-in-class at agent run-trees; not for JS errors.
- PostHog is best-in-class at product analytics; not either of the above.
- Combined free-tier cost: $0 at personal scale.

**Why not LangSmith.** Tightly coupled to LangChain/LangGraph ecosystem; we rejected LangGraph (ADR-0006), so LangSmith integration would be manual and lose its value props.

**Why not Helicone.** Proxy-based logging is good for "list of all calls" but weaker for agent run-tree visualization. Once you have multi-step boss/sub-agent runs, the tree view is the primary debug surface.

**Why not Phoenix / Braintrust.** Both eval-focused; nice-to-have for prompt iteration but not the v1 observability lane. Could layer in later for systematic prompt eval.

---

## ADR-0024 — Per-integration real-time update policy

**Decision.** Webhooks-where-available as primary; polling-as-fallback. Polling cadence per-integration based on freshness sensitivity. Hybrid policy because webhook delivery is occasionally lossy and some providers don't support push at all.

**Important framing.** OAuth gives alfred the _capability_ to read provider data; it doesn't give us a _trigger_ to know when something changed. For user-initiated queries, alfred queries live (no infra needed). For _passive indexing_ (keep the chunked corpus current) and _proactive features_ (email triage on arrival, reply detection, meeting prep on schedule), alfred needs change notifications — that's what this ADR is about.

**Per-integration starting policy:**

| Integration             | Webhook                                                | Polling                                   | Notes                                                                                                    |
| ----------------------- | ------------------------------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Gmail**               | `users.watch` → Google Pub/Sub → our `/webhooks/gmail` | Every 5min as fallback (uses `historyId`) | **Required** for email-triage UX (ADR-0025). Push channels expire ~7 days; cron renewal.                 |
| **Calendar**            | `events.watch` → push channel                          | Every 2min for next-24hr window           | Push channels expire 24hr–1mo; cron renewal. Fast polling because freshness dominates here per ADR-0010. |
| **Google Drive / Docs** | `changes.watch`                                        | Every 15min                               | Less time-sensitive; longer interval.                                                                    |
| **Slack**               | Events API (subscribe to message + channel events)     | None (Slack discourages polling)          | Public URL needed for Events API delivery.                                                               |
| **Linear**              | Webhooks per project/team                              | None                                      | Webhook + signature verify; webhooks reliable.                                                           |
| **GitHub**              | App webhooks per repo/org                              | None                                      | GitHub App architecture for org-wide visibility.                                                         |
| **iMessage**            | None (no API)                                          | N/A                                       | Local export ingestion only; deferred to a follow-up ADR (no clean ingestion path).                      |
| **Notion**              | None (no public webhook API)                           | Every 10min via `last_edited_time` filter | Polling-only; expensive at high page counts but unavoidable.                                             |
| **MCP servers**         | None (spec doesn't define push)                        | None                                      | Tools are call-on-demand; stateless from our side.                                                       |

**Architectural shape:**

- One public webhook endpoint per provider: `POST /webhooks/<provider>`. Each verifies signature, parses payload, enqueues a BullMQ job for async processing.
- Polling jobs in BullMQ with cron triggers (`gmail.poll`, `calendar.poll`, `notion.poll`). Each fetches deltas using a `last_sync_token` column on `integration_credentials`. Idempotent — webhook + poll converging on the same change is safe.
- Webhook subscription renewal: cron jobs keep Gmail/Calendar push subscriptions alive; backoff on failure.
- Idempotency: every incoming webhook dedup'd by `(provider, provider_event_id)` in `webhook_events` table; replay-safe (matches ADR-0014's idempotency story).

**Public webhook URL.** Railway gives `*.up.railway.app` domains for free; webhooks register against those. Custom domain at production polish, not v1 requirement.

**iMessage caveat.** No API. Three options: (1) periodic local export script + manual upload; (2) read `chat.db` from a synced macOS file (privacy-fraught); (3) defer until clear ingestion path. **Default: defer iMessage** — not blocking morning-briefing or core agent value at v1.

**Why hybrid (not webhook-only or polling-only):**

- **Webhook-only** loses changes during webhook outages or subscription expirations; polling fallback catches drift.
- **Polling-only** kills proactive UX — auto-tagging email at 5–15min lag is visibly broken vs Gmail's instant-receive feel.

---

## ADR-0025 — Built-in background workflows (v1 feature set)

**Decision.** Ship 7 built-in background workflows + 1 always-on system process (memory extraction). Each is a workflow per ADR-0017 (`is_builtin=true`, code-as-workflow in `apps/server/builtins/workflows/<slug>.ts`, seeded into the `workflows` table at deploy time). User toggles via settings page → flips `status` between `active` and `paused`.

| Feature                    | Description                                                                                                                                            | Default                | Trigger                      | Notes                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| **Email triage**           | Auto-classify every inbound email into a 10-bucket taxonomy (`urgent`, `action_needed`, `follow_up`, `awaiting_reply`, `meeting`, `fyi`, `done`, `payment`, `newsletter`, `marketing`); write Gmail label back | **ON**                 | Gmail webhook (per ADR-0024) | Cheap-tier classifier (Haiku/Flash). Re-evaluates on reply. Taxonomy widened from 6 → 10 (see amendment below).                                  |
| **Morning briefing**       | Daily 7am email: schedule + priority inbox (driven by triage tags) + relevant updates                                                                  | **ON**                 | Cron `0 7 * * *`             | Sent via Resend (ADR-0020).                                                                  |
| **Memory extraction**      | Per ADR-0019: end-of-thread + daily cron + event-triggered fact extraction                                                                             | **ON, not toggleable** | Multiple                     | System process, not a user feature.                                                          |
| **Evening recap**          | Daily evening email: what got done, what's still open, tomorrow preview                                                                                | **ON**                 | Cron `0 18 * * *`            | Closing-loop UX.                                                                             |
| **Reply drafting**         | When email tagged `awaiting_reply`, draft a response using `style_profiles` (ADR-0013); HIL-gated before send                                          | **OFF**                | Triggered by triage tag      | High-stakes (send-on-behalf); opt-in once user trusts drafts.                                |
| **Meeting prep**           | 30min before each meeting, send context email: attendees, recent threads with them, related docs                                                       | **OFF**                | Calendar event time          | Off until enough connected context to be useful.                                             |
| **Action item extraction** | Pull action items from emails/Slack threads into managed todo list                                                                                     | **OFF**                | Cron + event                 | Off until taxonomy maturation; partly redundant with email-triage `action_needed` tag at v1. |

**Implementation pattern (all features):**

- Built-in workflows live in code: `apps/server/builtins/workflows/<slug>.ts` (TS module, version-controlled, type-checked).
- Each references built-in skill markdown in `apps/server/builtins/skills/<slug>.md`.
- Seeded into DB at deploy time via a startup migration; updates on next deploy if changed.
- User-authored workflows sit alongside built-ins in the same `workflows` table; settings page renders both with the same toggle UX.

**Why these defaults:**

- **Triage + Morning + Evening + Memory ON** = the "alfred is working for you in the background" core value the day you connect Gmail. Without them, alfred is just a chat app.
- **Reply drafting OFF** = high-stakes outbound; needs trust earned via observation period.
- **Meeting prep / Action items OFF** = either redundant at v1 or needs more connected data to be useful; can be promoted as defaults once stable.

**Why not match dimension's defaults exactly:** their screenshot showed Morning Briefing OFF, which seems wrong for our use case (it's our killer feature). They may default off because their onboarding configures it later, or to avoid email volume for users who haven't connected calendar yet. We default it ON because alfred has nothing else proactive to offer if you skip it.

**Amendment (2026-05-21) — email triage taxonomy widened from 6 → 10 buckets.**

The original 6-bucket taxonomy (`action_needed`, `awaiting_reply`, `meeting`, `fyi`, `payment`, `newsletter`) was chosen for cheap-tier classifier reliability. After PR #21 switched to reusing the user's existing Dimension-style numbered labels (`1: urgent` through `10: marketing`), 4 of those 10 labels stayed unused. The user kept the full label set and asked for triage to cover all of them. New seams:

- `urgent` (`1: urgent`) vs `action_needed`: time-pressure. Hours-not-days consequence (security alert, account compromise, sign-in verification) → `urgent`; concrete-but-not-time-critical action → `action_needed`.
- `follow_up` (`3: follow up`) vs `awaiting_reply`: sender tone. Soft nudge / "any update?" / "circling back" on an existing thread → `follow_up`; direct first-ask requiring a reply → `awaiting_reply`.
- `done` (`7: done`) vs `fyi`: closure. "Order shipped" / "deploy succeeded" / "ticket resolved" → `done`; informational without explicit closure → `fyi`.
- `marketing` (`10: marketing`) vs `newsletter`: opt-in shape. Promotional / sales blast → `marketing`; subscription content the user opted into → `newsletter`.

**Tradeoff.** 10 buckets sits at the upper edge of what a cheap-tier model classifies reliably without examples. Mitigated by explicit per-seam disambiguation rules and worked examples in the system prompt. Lower confidence in tight pairs is expected and is what the `confidence < 0.5` "alfred wasn't sure" UX hook is for.

**Briefing downstream.** The morning briefing's priority/suppressed split (`packages/api/src/modules/briefing/gather.ts`) is updated alongside this amendment: `urgent` lands first in the priority order (so a same-day-actionable item never gets buried), `follow_up` after `awaiting_reply`, and `done`/`marketing` join `fyi`/`newsletter` in the suppressed counts. Display order mirrors the user's Gmail label numbering. Reply-drafting (ADR-0025 #5, still default-OFF) continues to key on `awaiting_reply`; whether to also draft for `follow_up` (softer touch — "thanks for the nudge, here's where we are") is left for when that workflow flips ON.

---

## ADR-0026 — `AlfredAgent`: per-turn LLM driver, not a tool-loop wrapper

**Decision.** Roll our own thin agent class (`packages/ai/src/agent.ts`) that exposes one `turn()` method per LLM round-trip, leaving the multi-step loop to the durable runtime (ADR-0006). Do **not** subclass or compose AI SDK's `ToolLoopAgent` (formerly `Experimental_Agent`).

Concretely:

- `AlfredAgent.turn({ ctx, transcript, attribution })` resolves model + tools + system per-turn, calls `meteredGenerateText` with `stopWhen: stepCountIs(1)` and tools whose `execute` has been stripped, and returns a discriminated `TurnResult` (`final` | `tool-calls` | `stopped`). One LLM turn = one `api_call_log` row.
- The durable executor (`@alfred/api/agent`) drives the outer loop: dispatch tools, append results to transcript, schedule the next `boss-turn` step, or interrupt for HIL.
- Tools are sorted alphabetically and the last definition + the system block both get an Anthropic `cacheControl: { type: 'ephemeral', ttl: '1h' }` annotation. Same tool set across turns within a run = within-run prompt-cache hits; same integration set across runs = cross-run hits.
- `system` is captured on the first turn and **strict-pinned** by default — drift between turns throws. The reason for drift is almost always an accidentally-baked-in run id, timestamp, or feature flag, all of which silently kill the prefix cache. Set `strictSystem: false` to log a warning instead.

**Why not `ToolLoopAgent`:**

- It owns its own multi-step loop. ADR-0006/0014 require checkpoints between turns so HIL interrupts and crash-resume work; nothing inside the SDK loop can park a run.
- ADR-0015 wants per-turn cost rows. `ToolLoopAgent.generate()` returns one aggregated `totalUsage`; `onStepFinish` doesn't carry latency or `MeteredMeta`, so we can't synthesize a faithful row from inside it.
- ADR-0016's boss/sub-agent topology fans out, not loops. Sub-agent spawn is an ordinary tool call routed by the executor's dispatcher to a child `agent_runs` row — the SDK's loop hides that from the runtime.
- Lazy integration loading needs the toolset to mutate **between turns within one logical agent call**. `ToolLoopAgent.prepareCall` is per-call, not per-turn; `prepareStep` exists on `generateText` but isn't surfaced on the agent class.
- Walking the source confirms the ergonomic ceiling: `ToolLoopAgent` is ~80 LOC of settings binding (`node_modules/.../ai/dist/index.mjs:7608`), with the actual loop inside `generateText` itself. Rolling our own gives up nothing structural.

**Lazy integration loading.** The active toolset is a property on `agent_runs.state.activeIntegrations: string[]` (no separate table). Initial set = the user's connected integrations + tools implied by active artifacts at run-start (e.g. "this thread mentions a Linear issue → preload linear"). Mid-run, a `load_integration(slug)` tool call appends to `state.activeIntegrations`; the `tools` resolver re-reads it on the next turn and rebuilds the set. Cache invalidates on the load turn and rebuilds from the next.

**Sub-agent isolation.** Per dimension's pattern + ADR-0016: sub-agents receive **only the brief** as their initial transcript. No parent transcript, no shared messages. They read parent state via tool calls into the namespaced scratchpad. The dispatcher constructs the child run with `transcript: [{ role: 'user', content: brief }]` — that's the entire interface.

**No in-class compaction.** `AlfredAgent` does not summarize transcripts. If a transcript approaches the model's context window, the executor calls a separate cheap-tier `compactor` agent (Gemini 2.5 Flash) between turns to condense older messages into a `<summary>` system note, then schedules the next turn. Sub-agents don't compact at all — if a sub-agent is approaching 80% context the brief was too broad, and the right answer is to fail back to the boss for re-decomposition rather than soldier on with a degraded view.

**Not implementing the SDK `Agent` interface (yet).** The interface contract (`generate()` returns aggregated `GenerateTextResult`, `tools` is a static getter) implies a full in-process tool loop and a fixed toolset, both of which we deliberately don't have. A thin adapter can satisfy it later if SDK utilities like `createAgentUIStreamResponse` get wired into the chat surface.

**Provider scope.** `cacheControl` is Anthropic-namespaced; non-Anthropic models silently ignore it. The `cacheControl: false` escape hatch exists for agents pinned to non-Anthropic models (e.g. the Gemini compactor) where the structural overhead of the wrapped system message has no upside.

**Quirks / open questions to revisit:**

- **Provider-aware cache annotation.** Today we apply `providerOptions.anthropic.cacheControl` even when the resolved model isn't Anthropic. Wasted bytes on the wire, no correctness issue. If perf becomes a concern, gate on `model.provider.startsWith('anthropic')`.
- **`AlfredProviderOptions` type laundering.** The class types `providerOptions` as `Record<string, Record<string, unknown>>` and casts at the SDK boundary, to avoid a direct dep on `@ai-sdk/provider-utils` for one type alias. Tighten when the SDK re-exports `ProviderOptions` from the `ai` barrel.
- **Cache breakpoint count.** Anthropic allows up to 4 ephemeral breakpoints per request. We use 2 (system, last tool). Adding a third on the last *static* user message (just before the recent-turns tail) is a future optimization once we have a compaction strategy in place.
- **Agent interface adapter.** Defer until SSE chat surface is wired (m13+). At that point either implement `Agent` directly or write a thin `toAgent(alfredAgent)` adapter.
- **Bash sandbox.** `bash` as one of the alfred-primitive tools needs a per-run ephemeral container (Docker exec or Firecracker) — host shell access is too much blast radius. Not blocking the class itself, but blocking the eventual built-in toolset; punt to its own ADR when we get to m13.
- **Read/write/edit scope.** Whether the `read`/`write`/`edit` primitives target a per-run scratchpad volume vs. user-owned notes/documents is not pinned. Default plan: per-run sandbox first (Claude-Code-shape, low stakes); user-data write paths surface as their own `notes_*` / `documents_*` tool groups loaded via `load_integration`.

**Alternatives considered:**

- (a) Wrap `agent.generate()` once in `metered()` — cheap to build, but loses per-turn rows and can't park between turns.
- (b) Subclass `ToolLoopAgent` and mete via `onStepFinish` — `onStepFinish` doesn't carry latency or MeteredMeta; partial rows; still no checkpoint per turn.
- (c) Use `generateText` with `prepareStep` for lazy loading — works for lazy tools, but the SDK still owns the loop, so HIL and crash-resume break.
- (d) **Roll our own per-turn class (chosen)** — a few hundred LOC, composes with the existing executor, every ADR constraint satisfied without surprises.

---

## ADR-0027 — Workflow trigger dispatch: generic `workflows.tick` + denormalized `next_run_at` + unified `trigger` on `agent_runs`

**Decision.** Three coordinated choices that together define how a `workflows` row becomes an `agent_runs` row:

1. **Cron dispatch is a single `workflows.tick` BullMQ repeatable** running every minute. There is no per-workflow BullMQ scheduler. The `workflows` table is the source of truth for "what should fire next."
2. **Scheduling state is denormalized onto `workflows`** as `next_run_at` and `last_scheduled_at` columns, with a partial index keying the tick query. `cron-parser` runs at write-time (when `trigger` mutates and after each fire), not in the per-tick hot path.
3. **`createRun` accepts a first-class `trigger` field**, mirrored on `agent_runs` as a `trigger jsonb` column. Cron, manual, event, and on-signal kinds all funnel through one `createRun` primitive — no per-kind execution paths.

**Why.**

- **One operational surface.** A second scan-and-fan-out tick (alongside `briefing.tick` per ADR-0025) keeps the operator's mental model coherent — every recurring fan-out in the codebase is "find a BullMQ tick log; read what it dispatched." Per-workflow schedulers would shard that view across N BullMQ entries.
- **Lifecycle is a row edit.** Activate/Pause/Edit/Delete on a workflow is a `workflows` UPDATE that also recomputes `next_run_at`. No reconciliation between two stores (the row and a BullMQ scheduler) is required. Per-workflow schedulers would require a hook on every mutation that adds/removes/replaces the BullMQ entry; mismatched state is a class of bug that doesn't exist here.
- **The tick is an index lookup, not a scan.** Denormalizing `next_run_at` + `(status='active' AND trigger->>'kind'='cron')` partial index means each tick is `WHERE next_run_at <= now() ORDER BY next_run_at LIMIT 100` — O(log n), no per-row cron parsing. `cron-parser` is a write-time dep, not a hot-path dep.
- **Idempotency is a BullMQ jobId, not a database read.** The tick enqueues with `jobId = workflow:{workflowId}:scheduled:{nextRunAtIso}`; BullMQ's native dedup makes a retried tick a no-op without consulting `agent_runs`. The next fire uses a different `nextRunAtIso`, so the jobId is unique per scheduled instant.
- **Unified `trigger` field future-proofs the event story.** Today m12 only emits `kind='cron'` and `kind='manual'` triggers. m13's event router (Gmail webhook, calendar push, etc.) builds the same `trigger` block (`{ kind: 'event', eventId, payload }`) and hands it to the same `createRun`. No second execution path to invent; no `metadata.triggeredBy` migration when event triggers land.
- **`trigger.kind` is a first-class filterable field.** "Show all event-triggered runs in the last 24h" or "filter History tab to cron-only" is a `trigger->>'kind' = '…'` JSONB filter — the `workflows` partial index already covers the cron-dispatch path; if `agent_runs` history queries ever need an index, add one on `trigger->>'kind'` (or promote to a generated column) at that point.
- **`trigger.scheduledFor` distinguishes wall clock from scheduled time.** A tick fired at `09:00:23` for the `09:00:00` schedule stamps `scheduledFor = "09:00:00"` and `started_at = "09:00:23"`. Useful when a deploy or Redis blip delays the tick.

**Schema sketch.**

```
workflows                                  -- new columns + index
  ADD COLUMN next_run_at        timestamptz
  ADD COLUMN last_scheduled_at  timestamptz
  CREATE INDEX workflows_next_run_at_idx
    ON workflows (next_run_at)
    WHERE status = 'active' AND trigger->>'kind' = 'cron'

agent_runs                                 -- new column
  ADD COLUMN trigger jsonb
    -- { kind: 'cron'    | 'event'    | 'manual'    | 'on_signal',
    --   scheduledFor?:  timestamptz iso (cron),
    --   eventId?:       text         (event idempotency key),
    --   payload?:       jsonb        (event payload),
    --   signalName?:    text         (on_signal) }
```

**Tick query.**

```sql
SELECT id, slug, user_id, brief, trigger, next_run_at
FROM workflows
WHERE status = 'active'
  AND trigger->>'kind' = 'cron'
  AND next_run_at <= now()
ORDER BY next_run_at ASC
LIMIT 100;
```

Per row: (1) `createRun({ workflowSlug, userId, trigger: { kind: 'cron', scheduledFor: nextRunAtIso } })`; (2) `enqueueRun(runId, { jobId: \`workflow:${id}:scheduled:${nextRunAtIso}\` })`; (3) compute `next_run_at` via `cron-parser` from the row's `trigger.schedule` + tz, UPDATE the row with new `next_run_at` and `last_scheduled_at = scheduledFor`. The `LIMIT 100` is a personal-scale ceiling — if N grows past one tick's budget, cursor on `next_run_at` and re-tick. Today 100 covers a lifetime; document the cursor as future work.

**`createRun` signature.**

```ts
createRun({
  userId,
  workflowSlug,
  input,
  trigger: { kind, scheduledFor?, eventId?, payload?, signalName? },
  metadata?,                  // remains for diagnostic breadcrumbs
})
```

Existing call-sites that pass `metadata: { triggeredBy: '…' }` migrate to `trigger: { kind: '…', … }` — most of them are builtin dispatchers (briefing tick, triage poll, cold-start callback) and migrate cleanly.

**Implementation notes.**

- `next_run_at` is recomputed at exactly two moments: (i) after a `workflows` write that changes `trigger` or flips `status` to `active`; (ii) inside the tick handler, right after `createRun` succeeds for that row. Both happen inside the same transaction as the row update for write-(i) and the same tx as `createRun` for write-(ii).
- Tz resolution: workflow row's `trigger.timezone` (first), else `user_preferences.timezone` (fallback), else `UTC` (final fallback) — same chain as ADR-0025's morning briefing.
- m12 ships only the dispatcher; the `createRun` for user-authored workflows lands as `failed` (reason `user_authored_brief_execution_pending_m13`) until the agent runtime fills in. This is a milestone-scoping note, not an architectural decision — captured in `CLAUDE.md`'s milestone status section and `CONTEXT.md`'s m12 scope.

**Alternatives.**

- (a) Per-workflow BullMQ scheduler with native cron pattern (rejected — adds lifecycle hooks on every mutation; shards the operational surface across N BullMQ entries; no read-view payoff at single-user scale; "BullMQ owns cron" optimization isn't load-bearing here).
- (b) Hybrid — builtins keep per-feature ticks; user-authored uses generic tick (rejected — creates two patterns; any new builtin would have to choose; doesn't simplify either side).
- (c) `pg_cron` (rejected — Postgres-extension dep, doesn't compose with BullMQ retry/observability story, no Railway-managed support for the extension).
- (d) Per-workflow Vercel/Inngest cron (rejected — vendor coupling for a primitive we already have via BullMQ; ADR-0006 already rejected vendor agent runtimes for the same reason).
- (e) Tick-time cron parsing without `next_run_at` denormalization (rejected — O(n) per tick + cron parsing in the hot path; "next 5 runs" UI requires the column anyway; the write-time cost is a single `cron-parser.next()` call).
- (f) Per-kind `createRun` variants (`createCronRun`, `createEventRun`, …) (rejected — three call paths means three places to keep in sync when adding fields; unified `trigger` matches the discriminated union we already validate at the `workflows.trigger` layer).

---

## ADR-0028 — Composer voice dictation: Web Speech API, browser-native, no server round-trip

**Decision.** When the composer mic button activates (post-m13), it uses the browser's `SpeechRecognition` API to stream interim transcripts directly into the textarea. No server-side STT, no audio bytes leave the device. Falls back to a disabled state with a tooltip on browsers without support (mainly Firefox desktop today).

**Why.**

- **Zero new infra.** No Whisper API call, no audio upload pipeline, no per-minute STT cost line in the cost-metering table. The browser does the recognition; we only see text.
- **Privacy posture stays consistent with single-user scope (ADR-0001).** Audio never traverses our server. The dictated text enters the existing composer path and is treated identically to typed input.
- **Distinct from ADR-0004's "no voice mode."** ADR-0004 rules out audio-in audio-out conversational voice (LiveKit-class infra). Dictation is a keyboard alternative — speech → text inserted into a text field the user can edit before sending. The two are unrelated capabilities; ADR-0004 doesn't preclude this.
- **Good-enough quality for personal use.** Chromium and Safari ship usable English STT for free; the user is the only target audience, so we don't need to engineer around accent/edge-case coverage.
- **Reversible.** If browser STT proves too lossy, swap the activation handler to call a `/api/stt` endpoint backed by Whisper/Deepgram — same UX, different transport. The composer doesn't care.

**Implementation sketch (when m13 lands the live chat surface).**

- `useSpeechRecognition()` hook in `apps/web/src/lib/` wrapping `window.SpeechRecognition || webkitSpeechRecognition`, surfacing `{ supported, listening, transcript, interim, start, stop, error }`.
- Mic button toggles `listening`. Interim results stream into the textarea as the user speaks; final segments commit on pause. User can edit before sending.
- Mobile: same API works on iOS Safari and Android Chrome. The `--keyboard-height` token from dimension's recon (ADR-0003 era) gives a hint about how to keep the composer above the IME, but no special handling needed for STT itself.
- Disabled state today (m12): the mic button renders with `disabled` + tooltip "Voice input — lands with m13". Keeps the chrome honest about what's wired.

**Alternatives.**

- (a) Whisper API on the server (rejected for v1 — adds STT cost line, audio upload, retry semantics; saves us nothing the browser can't do at single-user scale).
- (b) Local Whisper.cpp via WASM (rejected — ~50MB model download, cold-start cost; browser STT is faster and free).
- (c) No dictation at all (rejected — the composer mic icon is one of dimension's lifted patterns, and dictation is genuinely useful for longer-form prompts on mobile).

**Caveats.** Firefox desktop has no `SpeechRecognition` (Mozilla parked the spec). The fallback is "button disabled with tooltip" — acceptable for a personal tool where the user picks the browser. Chromium's STT also has a soft cap on session length (~60s) before it auto-stops; the hook should auto-restart on `end` if `listening` is still true.

---

## ADR-0029 — Composer model picker: opaque semantic tiers, never provider names

**Decision.** The composer's model picker exposes two values only: `Default` (the boss model — `getBossModel()`) and `Pro` (a higher-tier opt-in for complex tasks — points at the same family today, room to upgrade later). Provider/vendor names (`Claude`, `GPT`, `Sonnet`, `Opus`, etc.) are never shown in the user-facing UI. The chip renders disabled until m13/m14 wire actual routing.

**Why.**

- **Stack-locking pressure is real.** Once a user picks `Claude 4 Opus` from a dropdown, swapping the underlying SKU (whether for cost, latency, or a vendor migration) becomes a UX migration too. Opaque tiers keep the dispatcher (`getBossModel` / `getSubAgentModel` / `getCheapModel`) as the real source of truth — the surface stays stable while the SKUs underneath rotate.
- **Matches the existing dispatcher philosophy.** `@alfred/ai/provider` already abstracts models behind semantic getters (per CLAUDE.md). Hardcoding string model IDs at the UI layer would invert that — the dispatcher becomes a label resolver, not a routing decision.
- **Dimension's pattern, validated.** Dimension's recon (`references/dimension-dev/chat-anatomy.md`) confirms they ship only `Dimension` / `Dimension Pro` in the picker — same stance, different brand. The two-tier UX is enough for "I want this answered quickly" vs. "do the deep work" without polluting the surface with seven SKU choices.
- **Single-user scope (ADR-0001) doesn't change this.** Even with one user, future-me will appreciate the dispatcher boundary when a model gets deprecated mid-thread.

**Surface contract.**

- Default tier: routes through `getBossModel()` for chat turns, sub-agents pick their own model via the dispatcher (ADR-0016 + ADR-0026).
- Pro tier: same routing, but the boss model can be upgraded in-session (e.g. a "deeper" boss SKU when ADR-0021/0022 patterns suggest it's worth the cost). Today both tiers resolve to the same model; the chip exists so the upgrade path is wired before it's needed.
- The chip never shows raw model IDs. Settings or a debug surface can expose what's actually routing, but not the composer.

**Alternatives.**

- (a) Full provider dropdown (`Claude 4 Opus / Sonnet 4.5 / GPT-5 / …`) (rejected — locks the UI to specific SKUs; mirrors ChatGPT's surface but ChatGPT is selling SKU choice as a product, alfred isn't).
- (b) No model picker at all (rejected — losing the Pro affordance means we can't expose the "do the deep work" gear when it matters; the picker also doubles as an auto-mode toggle once `Auto` graduates from neumorphic decoration to a real routing decision).
- (c) Three+ tiers (`Fast / Default / Pro / Research`) (rejected — `Auto` already encodes "let the boss pick"; the cheap tier is dispatcher-internal, never user-selected; research-tier work goes through `getResearchModel()` triggered by tools, not by composer choice per ADR-0022).

**Caveat.** If a tier ever needs a sub-name (`Pro — fast`, `Pro — deep`), promote it to a second-level picker rather than collapsing back to SKU strings. The opacity is the invariant.

---

## ADR-0030 — Composer `+` menu and tab-autocomplete: deferred to post-m13

**Decision.** The composer's `+` button (in place of the older paperclip) and tab-autocomplete suggestion both ship as decoration-only in m12, with real behavior deferred:

- **`+` menu** — two items only at v1, mirroring dimension's recon (`chat-anatomy.md` §"Composer 'Add' menu"): `Add photos & files` and `@ Mention`. File upload pipeline depends on the ingestion stack post-m7; @-mention depends on the boss agent's awareness of skills/integrations (m13).
- **Tab-autocomplete suggestion** — when the boss agent has a probable next-prompt for the user, the placeholder is replaced with dimmed-text + a `[Tab]` keycap; Tab accepts. Depends on the boss agent producing those suggestions (m13) and the `agent.suggestion` event flowing over the existing SSE bus (ADR-0005).

**Why.**

- **The chrome is cheap; the behavior isn't.** Rendering a `+` icon and an empty popover takes minutes. The actual file-upload pipeline (chunker boundaries, dedup against `documents`, embedding budget per ADR-0010) is multiple PRs and likely needs its own ADR when it lands. Same for @-mention indexing — it needs to know the skill/integration registry the boss agent builds.
- **Don't ship half-wired affordances.** A `+` button that opens an empty menu is worse than no button. Disabled + tooltip ("Files & mentions — coming soon") matches the rest of the m12 stub surface (model picker, mic) honestly.
- **Tab-autocomplete is a m13 emergent behavior, not a m12 feature.** The suggestion only makes sense once there's an agent producing a continuation. Shipping the keycap UI before then would be cosmetic.

**When this becomes a real ADR.**

- File-upload pipeline: probably ADR-003x when post-m7 attachments land, covering MIME whitelist, dedup with the Gmail attachment path, max-size, virus-scan stance.
- @-mention: probably folded into ADR-0017 (skills) or a new ADR if the index turns out non-trivial — e.g. if mentions index people from contacts/Gmail headers in addition to skills/workflows.
- Tab-autocomplete: a small ADR when m13 has produced a real suggestion stream. Likely just "boss agent emits `agent.suggestion` over SSE; composer subscribes; one-shot per turn."

**Alternatives.**

- (a) Ship the `+` menu now with stubbed file-upload (rejected — invites half-broken UX; the upload box is meaningful surface area, not chrome).
- (b) Drop the `+` icon entirely and bring it back when behavior exists (rejected — keeps dimension parity worse than necessary; the icon being there + disabled signals intent without lying about what works).
- (c) Implement Tab-autocomplete with a stub suggestion (rejected — same problem as (a); fake suggestions train wrong muscle memory).

---

## ADR-0031 — People research dossiers: explicit, citation-grounded, review-before-memory

**Decision.** Add a first-class people-research capability that produces comprehensive, citation-grounded dossiers for people the user asks Alfred to understand. This is **not** an extension of `user_facts`: it researches third parties, stores the profile separately, and only promotes relationship facts into durable memory after review.

The implementation shape mirrors cold-start research (ADR-0011) but generalizes the subject:

- `packages/api/src/modules/people-research/` owns `collectPersonSignals` → `researchPerson` → `extractPersonProfile` → `persistPersonProfile`.
- Deep dossier runs use `getResearchModel()` / Perplexity Sonar Deep Research via `meteredGenerateText(..., attribution.kind = 'web_search')` (ADR-0022). Lightweight "quick lookup" can use `getWebSearchModel()` / Sonar Pro when the user asks for a short answer, but saved profiles come from the deep path.
- The durable runtime executes the pipeline as a workflow/run (ADR-0006), so 30-120s latency and retry/idempotency are handled like cold-start research.
- Output lands in `entities` / `entity_relations` plus dedicated profile tables, not in `user_facts` by default.

**Target output.** A saved dossier should have a stable, scannable shape:

- Identity match: canonical name, aliases/handles, identity confidence, matched signals, possible false matches.
- Professional: role, company, industry, public work history, notable projects.
- Organization context: company summary, stage/size/location, product/category, competitors where relevant.
- Connection to user: shared company/school/location, email/calendar/contact evidence, mutual context from user-owned integrations.
- Digital presence: LinkedIn, GitHub, X/Twitter, website/blog, other public profiles, each marked high-confidence or tentative.
- Education/location/interests: only when publicly attested or directly present in user-owned data.
- Unknowns: important fields that were searched but not confidently found.
- Research notes: disambiguation caveats, source-quality notes, and non-persisted weak inferences.
- Sources: citation list; every persisted claim must point to at least one source.

**Storage shape.**

```
person_profiles
  id, user_id, entity_id
  subject_name, subject_email?, subject_company?, subject_handles jsonb
  identity_confidence float
  summary text
  sections jsonb              -- rendered dossier sections
  sources jsonb               -- canonical source list
  research_notes text
  status enum(draft, saved, archived)
  run_id, created_at, updated_at

person_profile_facts
  id, user_id, profile_id, entity_id
  key, value jsonb, confidence float
  source_urls jsonb, rationale text
  sensitivity enum(public, user_owned, speculative)
  status enum(proposed, accepted, rejected)
```

`entities(kind='person')` remains the canonical graph node. `entity_relations` captures relationships (`works_at`, `met_with`, `emailed_with`, `same_school_as`, `reports_to`, etc.). `memory_chunks(kind='person_profile')` may hold the freeform dossier summary for semantic recall, but `user_facts` is reserved for facts about the user. A relationship fact such as "Alice is my manager" can be proposed into `user_facts` only through the existing correction loop (ADR-0019).

**Triggers.**

Start explicit-only:

- Chat/tool call: "research this person", "who is this candidate?", "prep me for meeting with X".
- Contact/profile UI action: "Research" or "Refresh profile".
- Workflow step: a user-authored or built-in workflow calls `research_person`.

Later, allow opt-in proactive triggers:

- upcoming meeting with an unknown external attendee,
- first substantial email thread with a new sender,
- imported contact with enough identifying signals.

No silent background research of arbitrary contacts at v1. Proactive triggers create a draft/review card, not an auto-saved profile.

**Quality rules.**

- Identity disambiguation is a first-class output. If the subject cannot be distinguished from similarly named people, return "no confident match" or a draft with caveats.
- Every accepted fact needs source provenance. Prefer public pages, company/team pages, personal sites, GitHub profiles, conference bios, and user-owned email/calendar/contact signals over SEO scraper pages.
- Weak inferences are allowed only in `research_notes`, never as accepted facts. Examples: age/career stage guessed from graduation year, cultural generalizations from location, surname guesses, or "likely works in X" from company makeup.
- Unknowns are valuable output. A sparse but honest profile is better than a padded one.
- The extractor is conservative: confidence below 0.7 is dropped; 0.7-0.9 remains proposed; 0.9+ can be accepted into the profile only if the user explicitly saves the dossier. Relationship facts still follow ADR-0019's correction UX.

**Privacy and safety boundaries.**

- Public web plus user-owned integrations only. Do not buy, scrape, or infer private data from people-search brokers.
- Do not include home address, personal phone, exact birthdate, government IDs, financial/medical data, or private family details.
- Family or relationship details for third parties are out of scope unless the user explicitly asks and the relationship is publicly stated by a reliable source; even then, default to a short note rather than durable facts.
- Do not run continuous monitoring of a person. "Refresh profile" is an explicit action or a narrowly scoped workflow step.
- Dossiers are for the user's personal context and preparation, not for automated outreach personalization that pretends to know private details.

**UX.**

- Saved profiles are reviewable/editable. The first deep run returns a draft card with section-level source links and fact-level accept/reject controls.
- The user can save the full dossier, save only relationship context, or discard.
- Low-confidence facts remain visibly proposed. Rejections should feed `rejected_inferences` so Alfred does not keep re-suggesting the same weak match.
- In chat, Alfred may answer from an existing profile but should mention stale profiles and offer a refresh when recency matters.

**Why separate from cold-start research.**

Cold-start is lifetime-once, self-research, and writes into `user_facts`/`memory_chunks` because the subject is the user. People research is repeatable, subject-specific, and often about someone else. Collapsing both into `user_facts` would pollute the user's memory with third-party attributes and make correction semantics unclear.

**Alternatives.**

- (a) Reuse cold-start research with a different prompt (rejected — wrong storage semantics, weak privacy boundary, and no person-identity lifecycle).
- (b) Live-only web search answers with no persistence (rejected — misses the dimension-style "assistant knows the people around me" value and repeats expensive research).
- (c) Auto-research every email sender/contact (rejected for v1 — cost, privacy, and false-positive risk; proactive research must be opt-in and review-first).
- (d) Put third-party facts directly into `user_facts` (rejected — `user_facts` should describe the user; third-party facts belong to profiles/entities, with only relationship facts proposed back to user memory).

**Open.**

- Whether `person_profiles` should Replicache-sync in v1 or stay server-rendered until the profile UI exists.
- Whether the dossier profile table should generalize to `entity_profiles` for organizations/projects/products. Start with people unless implementation shows the abstraction is free.
- Whether quick Sonar Pro lookups should ever be persisted, or only deep-research outputs.

---

## ADR-0032 — Burst dedup on per-credential ingestion: BullMQ `deduplication: { id, ttl }`, never a static `jobId`

**Decision.** Both call sites that enqueue `gmail.poll_history` (the webhook handler and the 5-min sweep) collapse simultaneous enqueues for the same credential via BullMQ's `deduplication: { id, ttl }` option — never via the legacy `jobId` option as a dedup key. The dedup id is `gmail.poll_history.{credentialId}` and the TTL is 30 seconds. The webhook and sweep share the same dedup id so a webhook arriving inside the same 30s window as a sweep enqueue collapses into a single poll, not two redundant ones.

**Why this is its own ADR.** The static-`jobId`-as-dedup pattern is the obvious-looking choice and it almost works. It bit prod twice in one session before we understood the failure mode and switched. The choice deserves the same surface area as a real ADR so future contributors don't reach for the same gun.

**Why static `jobId` fails.** BullMQ uses `jobId` for identity, not for dedup. The shape of the bug:

1. `defaultJobOptions.removeOnComplete` keeps completed jobs around (`{ count: 50, age: 24h }`) so the queue's history view is useful.
2. Once a job with a custom `jobId` has reached the `completed` set, a later `queue.add(..., { jobId: <same id> })` becomes a silent no-op until that completed row is garbage-collected. There is no error, no retry, no enqueue.
3. The mailbox keeps publishing pubsub notifications. Each one tries to enqueue with the same custom `jobId`. Each one is a no-op. Sync stalls without any failure signal until `removeOnComplete` evicts the stale entry — which can be hours later, or never if `age` hasn't elapsed.
4. The 5-min sweep doesn't rescue this because it uses the same static `jobId` and gets the same silent no-op.

We hit this twice in a single afternoon: PR #18/#19 first re-introduced the bug while fixing a different one (a `:` separator that BullMQ forbids in jobIds), and PR #20 finally diagnosed and replaced the static-id pattern with TTL dedup.

**Why `deduplication: { id, ttl: 30_000 }` works.**

- **It is documented dedup, not accidental identity.** BullMQ's `deduplication` option (v5+) is explicitly for "collapse enqueues for `id` that arrive within `ttl` of each other." It tracks dedup independently of the completed-set, so completion doesn't poison the next enqueue.
- **It releases on a wall-clock window, not on completion.** A real pubsub notification arriving 30s after the previous one enqueues a fresh job. A burst of notifications inside 30s collapses into one — which is exactly the load-shedding behavior we want.
- **Webhook and sweep share the same id.** `gmail.poll_history.{credentialId}` is used by both call sites. A sweep tick firing one second after a webhook delivery collapses into the webhook's poll; the next sweep 5 minutes later sees a fresh window.
- **30s is the right TTL.** Gmail publishes notifications at near-real-time cadence; bursts in the same second or two are common (a 5-message conversation, a thread settlement). 30s is long enough to collapse those bursts but short enough that a legitimate second push after a quiet period still enqueues. Longer TTLs (e.g. 1 minute) start swallowing real signal; shorter TTLs (e.g. 5 seconds) don't collapse the bursts that motivated this.

**Schema sketch.** No DB change; this is pure queue-config.

```ts
// packages/api/src/modules/integrations/gmail-webhook.ts
await queue.add(
  "gmail.poll_history",
  { kind: "gmail.poll_history", credentialId: cred.id, reason: "webhook" },
  { deduplication: { id: `gmail.poll_history.${cred.id}`, ttl: 30_000 } },
);

// packages/api/src/modules/integrations/queue.ts (sweep branch)
await queue.add(
  "gmail.poll_history",
  { kind: "gmail.poll_history", credentialId: c.credentialId, reason: "poll-fallback" },
  { deduplication: { id: `gmail.poll_history.${c.credentialId}`, ttl: 30_000 } },
);
```

The dedup id format is `gmail.poll_history.{credentialId}` with `.` separator (BullMQ forbids `:` in jobIds and we standardize on `.` for any id-like string we hand BullMQ, dedup-id or otherwise — a separator slip-up was its own session-of-pain).

**Worker log shape.** PR #22 added `skipped=` and `cursor=before->after` to the `gmail.poll_history` worker log so that the next time someone reads `inserted=0 errors=0`, they can tell at a glance whether Gmail returned no messages, returned messages that all dedup'd via `onConflictDoNothing`, or simply advanced the cursor during a quiet window. Worth restating: the dedup we're documenting in this ADR is at the queue layer (collapsing redundant *jobs*); `onConflictDoNothing` on `(userId, source, sourceId)` is the orthogonal dedup at the storage layer (collapsing redundant *documents*).

**Alternatives.**

- (a) Static custom `jobId` per credential (rejected — the bug this ADR exists to prevent).
- (b) Random `jobId` per enqueue, dedup-at-handler-time via SELECT-FOR-UPDATE on `ingestion_state` (rejected — pushes load-shedding into the worker, costs a DB row lock per burst event, and adds a code path that does nothing useful 99% of the time).
- (c) Webhook-only enqueue, no sweep fallback (rejected — Gmail pubsub is best-effort; a missed notification could stall a mailbox for hours, and the sweep cost is trivial at single-user scale).
- (d) Sweep-only, no webhook (rejected — 5-minute median ingest latency is unacceptable for the morning-briefing and triage UX).
- (e) Longer TTL (e.g. 5 minutes, matching sweep cadence) (rejected — sweep ticks are already idempotent against recent polls via `last_sync_at`, and a 5-min dedup window swallows real second-event signal; the 30s window collapses true bursts and lets sweep do its job).

**Generalization.** The same pattern applies to any future per-credential or per-account real-time poll: when both a push channel and a fallback sweep can enqueue the same kind of work, share a dedup id and a short TTL. Don't reach for `jobId`.

---

## Open / deferred

Items intentionally not decided yet. Each is a future ADR when its time comes.

**Deferred features:**

- **iMessage ingestion** — no clean public path. Options when revisited: periodic local-export script + manual upload, or `chat.db` reading from synced files. Not blocking v1.
- **Voice / phone calling** — `LiveKit Agents` is the natural revisit point if this becomes a goal (ADR-0004).
- **MCP server** (alfred-as-MCP-server for external agents to consume) — addable later as a wrapper over `packages/api` tools (ADR-0018).
- **Push / Slack DM / SMS notifications** — schema is forward-compatible (`notification_preferences.channels` is a jsonb list); add when v1 email-only proves insufficient (ADR-0020).
- **Email-reply parsing for memory correction** — structured emails with deep-link-to-app cover the use case at v1; revisit if free-form reply parsing becomes worth the brittleness (ADR-0019).
- **Background-task activity log UI** — flat table of recent agent runs (date/time, workflow, trigger reason, cost) with live updates as `agent.run` SSE frames arrive. Data is already in place: `agent_runs` (status, started_at, ended_at, output, metadata), `api_call_log` (sum cost_usd by run_id), `agent.run` events on the outbox/SSE bus. Implementation is one `GET /api/runs` rollup endpoint + a web route that subscribes to the existing SSE stream. Lighter than the M15 agent-trace UI (which gets the run-tree + per-step prompt/response inspection) — they should coexist, not collapse. Pick up alongside or before M15.

**Pinned at implementation time:**

- **Specific model SKUs** for boss/sub-agent/embedding/web-search — pulled from `models.dev` at implementation; ADRs name families (Voyage, Sonnet, Sonar Pro), not specific revisions (ADRs 0016, 0021, 0022).

**Tactical / not-architectural (decide while building):**

- Testing strategy (vitest baseline from milkpod; integration tests against a real Postgres via testcontainers).
- CI/CD specifics (Railway GitHub-push deploys; PR previews if needed).
- Secrets management (Railway env vars; Doppler/Infisical only if multi-env complexity grows).
- Package layout details (mostly mirrors milkpod's `packages/{ai,api,auth,config,db,env,sync}` plus new `packages/{integrations,ingestion}`).
- Drizzle migration workflow (already standardized in milkpod's `docs/database.md`).
- Search namespace warming pattern (dimension does this; layered onto ADR-0010's hybrid policy as part of integration ingestion).

---

## Suggested implementation order

The decisions are now self-contained enough to start building. Proposed milestone order:

1. **Scaffold** ✅ _done 2026-04-27_ — copied milkpod's pnpm + Turborepo + packages (`ai`, `api`, `auth`, `config`, `db`, `env`, `sync`) + `apps/server` + new `apps/web` (Vite + TanStack Router). `@alfred/*` namespacing throughout. Acceptance criteria from `scaffolding-plan.md` all green.
2. **Auth + first Railway deploy** ✅ _done 2026-04-28_ — Better Auth with emailOTP + one-email allowlist (ADR-0009; passkey deferred per ADR-0009 implementation note). Railway project provisioned (Postgres + Redis + server + web), initial Drizzle migration generated and applied via preDeploy. `/health` 200 with `db: connected`; web SPA serves; Better Auth endpoints reachable. Sentry (server + web) and PostHog (web) wired and initializing from env vars. M2-only env-var coverage: all 11 required + Anthropic, Google, OpenAI, Resend, Perplexity, Sentry DSNs, PostHog key/host. Lessons captured in `scaffolding-plan.md` so M1 won't repeat the migration-not-generated and PORT-hardcoded bugs.
3. **Replicache MVP** ✅ _done 2026-04-28_ — `packages/sync` with `noteCreate` mutator + zod arg schemas; server-side push/pull/CVR/poke at `/api/replicache/*`; per-user Redis Pub/Sub poke channel + SSE; refcounted subscribe; multi-device sync verified.
4. **Realtime stack** ✅ _done 2026-04-29_ — `events_outbox` table + AFTER INSERT trigger firing `pg_notify('events_outbox_new')`; LISTEN/NOTIFY-driven relay (`packages/api/src/events/outbox-relay.ts`) with `FOR UPDATE SKIP LOCKED` drain, publish-then-mark for at-least-once delivery, 5s backstop poll, reconnect-on-end. Generic `/api/events` SSE with `Last-Event-ID` and `?since=` replay, watermark-and-buffer to prevent replay/live duplication. `publishEvent({ tx, userId, kind, payload })` validates against per-kind zod schemas at insert time. Replicache pokes intentionally kept on a separate, lower-latency direct-emit bus (ADR-0005 lists pokes as one event type but the contract — idempotent hints, not durable state — argues against forcing them through outbox). End-to-end verified in browser: live SSE, multi-tab fan-out, replay-after-disconnect.
5. **Durable agent runtime** ✅ _done 2026-04-30_ — `agent_runs` checkpoint table + step function + BullMQ worker (`packages/api/src/modules/agent/{executor,worker,queue,service,registry}.ts`); idempotent step pattern with `(run_id, step_id, attempt_id)` keys (ADR-0006 + ADR-0014). `echo-with-approval` builtin workflow + `smoke-agent` / `smoke-agent-resume` scripts cover the resume-from-checkpoint path.
6. **Cost metering** ✅ _done 2026-04-30_ — `metered()` helper + `metered.text/object/embed` wrappers in `packages/ai/src/metering/`, `api_call_log` + `model_prices` tables, `pnpm sync-prices` script seeded from `models.dev` (ADR-0015). Langfuse trace export wired alongside (ADR-0023). `smoke-metered` / `smoke-metered-fail` cover happy-path + failure logging.
7. **First integration end-to-end (Gmail)** ✅ _done 2026-05-01_ — OAuth, ingestion job, live tools, webhook + polling, schema for `documents`/`chunks` with pgvector (ADRs 0010, 0024). Sub-tasks:
   - **7a** ✅ OAuth (gmail.readonly + send + modify scopes) + credentials table + `gmail.ingest_recent` BullMQ job that lists+fetches recent messages and writes raw `documents`.
   - **7b** ✅ Voyage embeddings + chunker (`packages/ingestion/{chunker,embed-document,search}.ts`) + `chunks` table with pgvector cosine + hybrid search helper.
   - **7c** ✅ Code complete: webhook (`/webhooks/gmail`) + `users.watch`/`users.history.list` bindings + `gmail.poll_history`/`watch_renew`/`poll_sweep`/`embed_sweep` jobs + 5min poll-fallback cron. Push-notification activation (Pub/Sub topic IAM, push subscription, watch install) deferred — see [`pending-setup.md`](./pending-setup.md). System runs on the polling fallback until activated.
8. **Memory primitives** ✅ — `user_facts`, `memory_chunks`, `style_profiles`, correction loop, `memory-extraction` builtin workflow (ADRs 0012, 0013, 0019).
9. **First built-in workflow: email triage** ✅ _done 2026-05-02_ — `email_triage` table keyed on `document_id`; six-bucket cheap-tier classifier in `packages/api/src/modules/triage/classify.ts` running through `metered.object()`; `email-triage` builtin workflow (`classify` → `apply-label`); `Alfred/<Cat>` Gmail labels managed by `packages/integrations/src/google/labels.ts` with id-map cache on `integration_credentials.metadata.alfredLabels`; `gmail.poll_history` fans out one triage run per fresh insert (skipping `fullResync`). Re-evaluation on reply is implicit — every new message is its own document and gets its own run. `smoke-triage.ts` exercises the full loop (LLM call + Gmail label round-trip + idempotent re-run). Settings-page toggle deferred to m12 (no `workflows` table yet).
10. **First built-in workflow: morning briefing** — proves cron → multi-source query → email send (ADR-0025 + ADR-0020).
11. **Cold-start research** ✅ _done 2026-05-03_ — `getResearchModel()` (Perplexity `sonar-deep-research`) + `getWebSearchModel()` (`sonar-pro`) added to `@alfred/ai/provider`; `meteredGenerateText` / `meteredGenerateObject` accept an optional `attribution.kind` so cold-start routes log as `web_search` (ADR-0015). `packages/api/src/modules/cold-start/` ships `collectColdStartSignals` (extensible per-integration; v1 contributes `{ name, email, emailDomain, integrations.google? }`), `researchUser`, `extractColdStartFacts` (cheap-tier transformer), and `hasPriorColdStartRun`. `cold-start-research` builtin workflow runs `gather-signals` → `research` → `extract-facts` → `persist`; persist calls `proposeFact()` (auto-confirm gated by ADR-0019) per proposal and writes one `memory_chunks` row at `kind='cold_start_research'`. Trigger lives on the Google OAuth callback (`google-routes.ts /callback`), gated by `hasPriorColdStartRun` so a re-connect doesn't re-run; the trigger choice is dictated by Google being the only m11-era integration that contributes signals beyond the user row. `smoke-cold-start.ts` forces a run for the first user (skipping the trigger-side dedup) and verifies output shape + chunk + per-run facts.
12. **Skills + user-authored workflows** — authoring surface only; execution deferred to m13 (ADR-0017, ADR-0027). Sub-tasks:
    - **12a** Workflows CRUD API (`packages/api/src/modules/workflows/` — list/get/create/update/delete + status toggle; builtins immutable except `status`; rejects writes to `steps` with "explicit DAGs land in a later milestone").
    - **12b** `/workflows` list + `/workflows/$slug` brief editor (matches the dimension authoring shell: Plan / History / Approvals tabs, Schedule segment lit, Triggers segment disabled with "lands with m13" tooltip, Auto-approve toggle as inverse of `hil_gates`, Activate flips `status`). No DAG editor (ADR-0017 reaffirmed).
    - **12c** Replicache sync for workflows (`SyncedWorkflow`, `IDB_KEY.WORKFLOW`, fetcher, server mutators for status toggle + brief update). Same shape as the shipped skills sync.
    - **12d** Cron dispatch (ADR-0027): generic `workflows.tick` running every minute + `cron-parser` matcher. `manual` trigger ships as a "Run now" button → direct `createRun`. `event` / `on_signal` dispatchers deferred to m13.
    - **12e** Settings page: unified active↔paused toggle for builtins + user-authored. Closes the m9 deferral.
    - **Execution stub**: `createRun` for `is_builtin=false` workflows lands as `failed` with reason `user_authored_brief_execution_pending_m13`. History tab on the workflow detail page shows those rows honestly. m13 replaces the stub with the real `AlfredAgent` loop.
13. **Boss + sub-agent orchestration** — replaces m12's execution stub. Builds the tool registry + tool dispatcher + `load_integration` + `AlfredAgent`→runtime bridge + sub-agent spawning + `event`/`on_signal` dispatchers all in one pass (ADRs 0016, 0026).
14. **MCP client** — connect external MCP servers, register their tools (ADR-0018).
15. **Observability polish** — review Sentry/PostHog/Langfuse instrumentation; add agent-trace UI surface in alfred itself (ADR-0023).
