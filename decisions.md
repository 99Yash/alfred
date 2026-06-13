# Alfred — Architectural Decisions

A running record of design decisions made while scoping alfred (a personal-assistant agent in the spirit of dimension.dev). Each entry: the choice, the rationale, alternatives considered, and any caveats.

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
| Orchestration         | Boss + namespaced scratchpad (sub-agents auto-write `scratch.{sub_id}.*`, boss promotes to `shared.*`); Redis primary + Postgres snapshot at terminal step (ADR-0036) |
| Skills                | Markdown docs with optional frontmatter; activated via `@skill:slug`                                              |
| Workflows             | Trigger + brief + optional explicit step DAG; mostly brief-only                                                   |
| MCP                   | Client-side only (consume external MCP servers); server-side deferred                                             |
| Memory correction     | In-app cards + chat-extraction; confidence-tiered auto-confirm; cron + end-of-thread + event-triggered extraction. **Amended by ADR-0056:** governance flips to **autonomous-write + tiered-notify + always-reversible** — confidence gates notification cadence + the `proposed`/`confirmed` review label, not the write; per-kind lifecycle (no global TTL); write-time-contradiction + user-feedback self-correction (decay deferred); rejection `cause` provenance; cheap-model terse rationale per write (→ SEARCH-001); user corrections feed the eval lane, no auto-tuning |
| Notifications         | Email only at v1 (Resend); morning briefing is the email itself; push/Slack/SMS deferred                          |
| Embedding             | Voyage family (voyage-context-3 ingestion, voyage-3.5 query) at 1024 dim, cosine, HNSW; Gemini fallback           |
| Web search            | Grounded Gemini 2.5 Flash (live `system.web_search` tool, 2026-06-12); Perplexity Sonar Deep Research (cold-start onboarding — stranded pending re-billing)                    |
| Observability         | Sentry (errors) + PostHog (product analytics) + Langfuse (agent traces) — all on free tiers                       |
| Integration freshness | Webhooks where available + polling fallback (per-integration policy table in ADR-0024)                            |
| Built-in features     | 7 background workflows shipped with the app (ADR-0025); user-authored workflows alongside                         |
| Workflow trigger dispatch | Generic `workflows.tick` + denormalized `next_run_at` + unified `trigger` on `agent_runs` (ADR-0027)          |
| Composer voice input  | Browser-native `SpeechRecognition` (Web Speech API); no server STT (ADR-0028)                                     |
| Composer model picker | Opaque tiers (`Default` / `Pro`); never raw provider/SKU names (ADR-0029)                                         |
| Composer `+` menu / Tab autocomplete | Decoration-only in m12; behavior lands post-m13 (ADR-0030)                                         |
| People research       | Explicit, citation-grounded person dossiers; review before durable memory writes (ADR-0031)                       |
| Content privacy       | Vendor at-rest crypto + log redaction + no `documents.raw`; no app-layer encryption at v1 (ADR-0038)              |
| Attachment ingestion  | `attachments` + `attachment_pages` tables; Claude PDF/image extraction; dedicated `doc-extraction-runs` queue; four-gate cost shield (ADR-0039) |
| Brief-only run shape  | Ping-pong `boss-turn` ↔ `dispatch-tools` steps; sentinel `userAuthoredBriefWorkflow` resolves all user-authored slugs; `agent_runs.transcript` jsonb; strict `@`-mention seed (ADR-0040)        |
| Daily briefing        | Renders of an **open-loop** model, not input summaries; **morning discretionary** (silent on quiet days, errs toward sending) + **evening always-fires** (degrades to weather + sign-off); compose-time **read-only reconciliation** (triage labels immutable); recall anchored to calendar; advance-reminders/anomaly-detection parked (ADR-0048, amends ADR-0041). Retained from ADR-0041: cross-source gather, boss compose, `[[<kind>:<id>]]` references, split email/in-app surface, `briefings` entity |
| Email triage pipeline | Layered: deterministic sender-context extraction + cheap classifier + boss `deepen` escalation gate + async dossier auto-trigger with confidence-tier TTL cache (ADR-0042)                       |
| In-app briefing surface | Paragraph-first day view (`breaking_summary` leads; `sourcePanels`/`sections` are collapsible support); day-keyed routes `/briefings` + `/briefings/$date` with stacked morning/evening slots; reference resolver relocated to `@alfred/contracts` so web resolves synced prose against synced `gather` (one truth, two renderers); no quiet-day mode; Replicache-only 30-day list via `IDB_KEY.BRIEFING` (ADR-0049) |
| Integration write surface | Write tools are first-class; authorization = tool registry + active tool exposure bounded by `workflows.allowed_integrations` + `user action policy` (default `gated`); no structural write-block (ADR-0043, supersedes ADR-0033's no-write rule) |
| OAuth posture | Multi-tenant-capable architecture, operated single-tenant; Google consent screen Production-unverified; least-privilege scope tiers, one restricted concession (`gmail.modify`); scope set tracks registered tools (ADR-0044) |
| Workflow event dispatch | Generic `emitEvent` bus; triage unified onto it (no more hardcoded fan-out); `source`+`type` closed enums (`gmail.message_received`); bounded resolve-at-init `<trigger_event>` context; bounded idempotency (ADR-0047, extends ADR-0027) |
| Todos | First **persisted** materialization of the open-loop model (ADR-0048 keeps loops ephemeral); one `todos` table, status-driven (`suggested\|open\|done\|dismissed`); hybrid authoring (user adds; Alfred proposes via `system.suggest_todo`, no HIL); multi-source `sources` provenance; v1 **passive** (agent authors + assists, never executes); **suggestions produced real-time off the `email-triage` run, not the briefing — briefing fully decoupled** (ADR-0050 amendment 2026-06-05); **todo-worthiness is an orthogonal rubric** (obligation → significance → memorability → actionability → already-handled), category floor shrunk to `{marketing, newsletter}`, decision traced via `todoDecision` (ADR-0050 amendment 2026-06-06); **stringency reframe — significance = real/external stake, manufactured + ceremonial urgency excluded, ownership-attribution gate (minimal identity), bot carve-out model-judged not slug-floored, terse-imperative voice, validated by a dry-run backfill** (ADR-0050/0051 amendment 2026-06-09); agent-execution + cross-source auto-close + semantic dedup + personal-relevance significance deferred (ADR-0050) |
| Integration loading | Deterministic, not prompt-inferred. v1 uses **eager connected tool declaration**: declare full schemas for connected ∩ `allowed_integrations` at run start (small bounded surface today), with an always-on connected summary for human-readable grounding. The **dispatcher is the security floor**: resolves bare/qualified names and **hard-enforces** `allowed_integrations` + scope-aware connection health before any registered tool executes. Closes the ADR-0043 exposure-only cap hole; supersedes the prompt-only "infer/load integration" instruction of ADR-0026/0040. Lazy/catalog/auto-activate is deferred until schema volume proves it is needed (ADR-0053) |
| Meeting prep | Pre-meeting context note per calendar occurrence. Mirrors the briefing pipeline: deterministic **gather** (event + attendees + email threads from `documents` + memory facts + todos) → **boss-tier compose** (cited `[[meeting\|email\|todo:id]]` note) → persist to **`meeting_preps`** keyed `(user_id, event_key)`, **upsert/recompute-in-place**, Replicache-synced read-only. Proactive trigger folded in: **calendar `events.watch` push** (HTTPS callback, no event mirror; `syncToken` in credential metadata) + **48h horizon + ~20m sweep**, dispatched via the `emitEvent` bus — all three triggers converge on `system.prepare_meeting`. **Gated recompute** (`material_hash`): time-only event shift skips compose, material change recomputes — minimize compose *frequency*, not tier. Delivery (pre-meeting email, web augmentation) deferred to MEET-002 (ADR-0054) |

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

**Source for model registry / pricing seed.** `models.dev` provides public model pricing + capabilities; `pnpm --filter @alfred/db db:sync-prices` pulls + upserts into `model_prices` with today's `valid_from`.

**Alternatives.**

- (a) Single agent (rejected — context-window economics; 200K-token bloat from irrelevant tool results).
- (b1) Strictly isolated sub-agents with no shared context (rejected — forces serialized dependencies or duplicate-brief context).
- (b2-free-form) Free-form sub-agent-writes scratchpad with no scoping (rejected — race conditions, compound-error risk).
- (b-boss-only-writes) Boss-only-writes shared context (rejected — pays expensive-model cost to retype sub-agent outputs that the cheap sub-agent already produced).
- (b3) Direct inter-agent messaging (rejected — emergent coordination, hard to debug).
- (c) Hierarchical (rejected — unbounded depth/cost/latency; re-plan is the right primitive).
- (d) Workflow-graph only (rejected — loses the agent's value of choosing what to do at runtime; see ADR-0017 for how deterministic workflows still fit).
- (e) Actor model (rejected — cron + skills cover the persistent-agent pattern at our scale).

**Amendment (2026-05-22) — store layer moved to Redis (ADR-0036).**

The "no Redis for this layer" line is superseded. Live scratchpad reads/writes now go to Redis during a run; the executor's terminal step writes a per-key snapshot to `agent_run_context` for durable audit/replay. The rest of this ADR's pattern (namespaced scratchpad, boss-promotes-to-shared, single-writer-per-zone, 1-level depth cap, sub-agents don't compact) is unchanged. See ADR-0036 for the durability composition and crash-resume story.

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

**Amendment (2026-06-12) — live tool moved to grounded Gemini.** The Perplexity account lost billing (`401 insufficient_quota`), so the **live agent web-search tool** was re-pointed from Sonar Pro to **grounded Gemini 2.5 Flash** (`getWebSearchModel()` + `googleSearchGroundingTools()`, Google Search grounding via `@ai-sdk/google` — the `google_search` provider tool runs server-side inside one generation). Same `system.web_search` dispatched function tool, same `metered(kind=web_search)` path; citations now read from `providerMetadata.google.groundingMetadata.groundingChunks[].web.uri`. Rationale beyond cost: the Gemini key was already held, latency is comparable (~5s), and it avoids a second vendor dependency. Caveats live with this choice: (1) web search is now **provider-locked to Gemini** — the `getWebSearchModel()` abstraction is the seam if we want a Gemini↔X fallback later; (2) grounding adds a per-request Google fee on top of tokens that `model_prices` doesn't yet capture (trivial at single-user scale); (3) Gemini grounding quality vs. Sonar Pro is unvalidated — a candidate for an evalite bake-off (ADR-0055). **Cold-start / dossier Deep Research (`getResearchModel()`) is still Perplexity and therefore stranded** until billing is restored or it too migrates to a grounded-Gemini research loop (the "powerful research sub-agent" / option C direction).

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
| **GitHub**              | App webhooks per repo/org (deferred — see ADR-0052)    | `/notifications` two-tier poll (~10min)   | **v1 polls** the authenticated API on the existing `repo` scope (ADR-0052); GitHub App webhooks are the deferred real-time upgrade, criterion = one-click connect, zero post-auth setup. |
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

**Amendment (2026-05-26) — triage pipeline rebuilt as layered classifier with boss escalation (ADR-0042).**

ADR-0042 keeps the 10-bucket taxonomy from the prior amendment but rebuilds the pipeline shape. The classify step gains a deterministic `extract-sender-context` prefix that emits typed `SenderContext` (bot vs human vs service, body-actor parsing for GitHub/Calendar/Linear, `botSlug` from a curated allowlist). Rule #9 splits into 9a/9b/9c: bot review comments -> `fyi`, severity-suspect bot alerts (Sentry, Stripe billing, Google security, Vercel deploy, Datadog) classify on body content, unknown service envelopes use today's behavior. A boss-tier `deepen` step is eligible when the cheap classifier's confidence is low, OR sender is in `SEVERITY_SUSPECT_BOTS`, OR sender is an unknown human in an important category; initial rollout executes severity-suspect bots live and shadows the other two branches. Bio-aware tagging is deliberately scoped to `deepen`: the cheap classifier remains email-only, while the boss can call `system.read_user_context` to pull the user's compact profile, preferences, relationships, current company/projects, and later saved dossiers. Dossier work for unknown human senders fires async via the ADR-0031 workflow with `person_profiles`-backed TTL caching once the unknown-human branch is promoted live. See ADR-0042 for the full pipeline shape, cost calculus, and failure model.

**Amendment (2026-05-26) — morning briefing rebuilt as cross-source LLM compose with split surface (ADR-0041).**

ADR-0041 supersedes the m10 deterministic-render path. The briefing workflow stays `gather → compose → send`, but `gather` now spans five sources (email triage rollup + Calendar + integration activity + Weather + day-of-week, with a `BriefingContributor` extensibility contract), and `compose` becomes a single `getBossModel()` call producing both a 4-6 line breaking summary (the email body) and a structured full briefing (the in-app surface). Entity references use `[[<kind>:<id>]]` placeholders resolved per-surface; operational references use a generic `activity` kind rather than provider-specific `pr` / `commit` / `repo` kinds. A new `briefings` table is the canonical record, Replicache-synced read-only with a 30-day pull window. ADR-0033's inbox-only bound is widened in tandem.

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

**Amendment (2026-05-22) — strict-seed `@`-mentions, not all connected integrations (ADR-0040).**

The "Initial set = the user's connected integrations + tools implied by active artifacts at run-start" line is refined for user-authored brief-only workflows. The initial `state.activeIntegrations` is `parsed @<slug> mentions in the brief ∩ workflows.allowed_integrations` (empty allowlist = unrestricted, but the parser still requires explicit `@`-mentions). An empty initial set is legitimate; the boss grows the set via `system.load_integration(slug)`. ADR-0026's "lazy integration loading" mechanism is intact — only the seed policy is refined. Rationale: determinism across runs of the same brief, tool-definition cache stability, and explicit authoring intent. See ADR-0040 for the parser shape and full reasoning.

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
- m12 shipped only the dispatcher. The planned failed-run stub for user-authored workflows was scoped out before ship, so pre-m13 code threw on registry miss before inserting an `agent_runs` row. m13 replaces that behavior with the sentinel workflow fallback in ADR-0040.

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
- Public relationships: family, cofounder, advisor, investor, collaborator, or other relationship context only when the relationship is publicly attested by a reliable source or present in user-owned data. Family discovery is allowed as a searched section when the user asks for deep people research, but weak/private findings stay in research notes or are omitted.
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
- Family or relationship details for third parties are out of scope for quick lookup and automated triage enrichment. Deep people-research may search for publicly attested family/relationship context when the user asks for a dossier, but the output must stay source-cited, high-confidence, non-sensitive, and short; minors and private-family details are omitted.
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

**Amendment (2026-05-26) — triage-driven auto-trigger + confidence-tier TTL caching (ADR-0042).**

The "later, allow opt-in proactive triggers" line in the Triggers section gains a concrete first proactive trigger: triage's `deepen` step (ADR-0042). When the escalation gate fires live on an unknown human sender in `urgent` / `action_needed` / `awaiting_reply`, the triage workflow enqueues this ADR's `person-research` workflow as an async side-effect, NOT a blocking step. The current email's classification proceeds without the dossier; future emails from the same sender benefit from the cached profile. Initial rollout shadows this unknown-human branch (logs `wouldDeepen`, `wouldDeepenReason`, `deepenExecuted=false`, `shadowOnly=true`, and `dossierRequested=false`) until contact/memory quality and firing rate are observed; the live side-effect is enabled after that rate is acceptable. Privacy semantics intact — the dossier still surfaces as a review-before-memory draft card before any fact lands in `user_facts`; the "no silent background research of arbitrary contacts at v1" rule is preserved because the trigger is gated on triage importance, not on contact appearance. The `person_profiles` rows themselves act as a cache: stale-by-confidence-tier (`identity_confidence` ≥0.9 → 90d, `0.7-0.9` → 30d, `<0.7` → 7d) triggers re-research only when the sender re-appears in an important triage category. Cache key is the stable sender identifier — `email` for direct senders, `service:handle` for body actors (e.g. `github:coderabbitai`).

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

## ADR-0033 — Daily briefing fidelity is bounded by per-source OAuth: Google now, GitHub queued

**Decision.** The LLM-composed daily briefing (built atop m10, scaffolded 2026-05-21) is explicitly scoped to whatever per-source data alfred has ingested. v1 ships against Gmail only (the existing `briefing` feature in `GOOGLE_FEATURE_SCOPES`); Google Calendar (`calendar.readonly`) is the next scope to land and is treated as a hard prerequisite for "what's on today" / "what's on tomorrow" content; GitHub OAuth is queued as the next integration boundary after that and is the prerequisite for accurate PR-state awareness. The briefing agent's tool surface (`list_calendar_events`, `list_action_items`, `list_meeting_preps` in the scaffold) is shaped now to consume those signals when they exist and returns `[]` until they do — no prompt rewrites needed when each lands.

**Why this is its own ADR.** ADR-0025 #2 committed to a daily briefing but pinned v1 at "inbox-only, calendar deferred." The 2026-05-21 scaffold supersedes that compose step with an LLM agent — at which point fidelity stops being a UI question and starts being an integration question. A user-visible regression we hit on day one: the morning briefing re-surfaced PRs the user had already merged, because alfred has no GitHub read path and can't verify state. That's not a model failure; it's a scope failure. The decision deserves its own ADR so subsequent integration work doesn't reopen the question of whether briefings can "fake it" without the underlying signal.

**Why we don't paper over the gap with cleverness.** The temptation is to LLM-route harder: have the agent infer merge state from email signal ("if there's been no review-comment email about PR #16 in 5 days, assume it's merged"). Rejected because (a) the false-positive cost is high — the briefing tells the user a stale thing as fresh — and (b) the right primitive is the integration, not a heuristic. The prompt-level guardrail we did add ("don't re-surface a PR named in a recent prior briefing absent fresh signal") is a band-aid: it stops repeated noise but doesn't gain truth; with GitHub it goes away.

**Integration sequencing.**

1. **Google Calendar** (`calendar.readonly`). Smallest scope expansion — the existing `GOOGLE_FEATURE_SCOPES` shape already supports adding `calendar` as a feature; the briefing scope set picks it up via `scopesForFeatures(['briefing'])` once added. Wires the agent's `list_calendar_events` stub into a real read. Unlocks: meeting-aware morning briefings, evening "tomorrow looks like…" line.
2. **GitHub OAuth** (`repo` read, or a tighter `public_repo` if the user's repos are public). Larger scope of work — new integration credential, ingestion, polling/webhook story per ADR-0024. Unlocks: PR-state awareness in briefings, the future meeting-prep agent's "this PR is the engineering-standup topic" cross-reference, and the action-items agent's GitHub webhook trigger (per Ronit's background-agents post).
3. **Everything else** (Linear, Slack DM, Notion) — deferred. Each opens its own ADR when ingestion lands.

**What does NOT change.**

- The agent's tool surface is stable. `list_calendar_events`, `list_action_items`, `list_meeting_preps` already exist and return `[]`; the agent's prompt already names them. When each is wired, no agent code or prompt rewrite is required.
- The briefing workflow shape (`gather → compose → persist → send`) doesn't change per integration; the watermark + prior-briefing memory layer is generic.
- The OAuth refactor that landed alongside m10 (`GOOGLE_FEATURE_SCOPES` + `scopesForFeatures(features?)`) is the right shape for per-feature scope opt-in. The same `requireScopes()` guard pattern transplants to GitHub when it lands.
- The "safety through architecture" rule from the background-agents recon: briefing agents have no `send_email`, no `draft_reply`, no general `web_search`. Adding integrations expands the *read* surface, never the *write* surface, regardless of OAuth scopes available on the underlying token.

**Alternatives.**

- (a) Build GitHub state into the briefing now by parsing PR URLs out of email bodies and screen-scraping the merge state from the GitHub web UI (rejected — fragile, not a real integration, doesn't unlock anything beyond this one symptom).
- (b) Block the LLM-composed briefing from shipping until GitHub is wired (rejected — Gmail-only briefings still beat the deterministic m10 for inbox content, and Calendar lands sooner; staging the integrations is the whole point).
- (c) Drop PR mentions from briefings entirely until GitHub is wired (rejected — the user routinely cares about review-comment emails on their own PRs; surfacing those with the noted band-aid is better than silence).

**Trace back to the symptom.** 2026-05-21 morning smoke output included "PR #16, PR #24, and PR #25 are all ready for you to take a look" — all three were already merged. The prompt-level guard now in place reduces repeat-noise; the actual fix is GitHub OAuth.

**Amendment (2026-05-26) — inbox-only bound widened to full cross-source gather (ADR-0041).**

The "v1 ships against Gmail only" position is superseded by ADR-0041's five-source gather: email triage rollup + Google Calendar + integration activity + Weather + day-of-week. The integration-sequencing argument here remains correct (each source is gated on its OAuth scope or external dependency landing first), but the briefing workflow itself no longer ships in an "inbox-only" v1 shape. The agent's deterministic gather (`list_calendar_events`, `list_action_items`, `list_meeting_preps` stubs returning `[]`) is replaced by a typed `BriefingContributor<T>` contract per source; each contributor returns `null` or an empty activity list until its underlying integration is wired, and the composer's prompt handles empty cases verbatim. The "don't paper over the gap with cleverness" rule still applies — when a direct provider state isn't readable, the briefing must say so, omit, or mark the item as email-triage backfill rather than infer. The "safety through architecture" rule (briefing agents have no `send_email`, no `draft_reply`, no general `web_search`) is preserved by ADR-0041's compose call having no tool surface at all — it's a single structured-output `generateText` over the gather, not an agent loop.

**Amendment (2026-05-27) — the "never expand the write surface" rule is superseded by ADR-0043.**

The blanket claim that integrations "expand the *read* surface, never the *write* surface, regardless of OAuth scopes" no longer holds product-wide. ADR-0043 makes write tools first-class, authorized by the composition of tool registry + active tool exposure bounded by `workflows.allowed_integrations` + `user action policy` (default `gated`). The specific guarantee that *the briefing* never writes is unchanged — but it now rests on ADR-0041's compose call being tool-free by construction, not on a global no-write rule. Read this ADR's "expands read, never write" line as scoped to the briefing/compose path; ADR-0043 governs everywhere else.

---

## ADR-0034 — Human-in-the-loop approval taxonomy + action staging

**Decision.** A per-user **action policy** (`user_action_policies`) drives a per-tool-call gate check inside the dispatcher. The dispatcher classifies every tool call against the policy *before* invoking `execute`. Gated calls write an **action staging row** (`action_stagings`) and park the run with the existing HIL wake primitive, using the staging id as the wake approval id (`wakeCondition.kind='hil'`, `approvalId=stagingId`) plus an action-staging discriminator. The user decides in-app (approve / approve-with-edits / reject-with-reason); a debounced BullMQ delayed job emits an email notification only if the user hasn't decided within the threshold. On resume, the dispatcher invokes `execute` with the (possibly edited) input — or, on reject, synthesizes a structured rejection tool-result with retry-suppression enforced inside the dispatcher.

Three orthogonal pieces compose into this:

1. **Policy storage** — `user_action_policies` (one row per user; jsonb integration rules; const-narrowed mode union from `@alfred/contracts`).
2. **Execution gate** — pre-execute interrupt via existing `wakeCondition.kind='hil'` (ADR-0006).
3. **Notification debounce** — staging row → SSE poke immediately + BullMQ delayed job (default 5min) → email only if still `pending`.

**Why each piece.**

- **Per-user policy, not per-tool defaults.** A central registry of "gmail.send_draft is always high-risk" is brittle as the registry grows; the policy lives where decisions live (with the user). Tool registration declares a `riskTier` (`no_risk | low | medium | high`) purely as a UX hint — drives the integration-card summary, staging badges, and email subject prefix. The dispatcher never reads `riskTier` for gating decisions.
- **Pre-execute interrupt over synthetic pending result.** Hooks directly into ADR-0006's `interrupt()` and ADR-0014's idempotent-resume model. Boss-turn loop integrity stays clean: the boss reasons about tools and results, not approval state. A synthetic-pending alternative would force a fourth `TurnResult` case onto `AlfredAgent` (ADR-0026) and double tool-call cost on every gated action.
- **Single staging table for gated AND autonomy tool calls.** Audit-log uniformity beats saving the insert. One query for "everything Alfred did," one bus for "agent did X" SSE pokes, one shape for the History tab. Autonomy rows transit `pending → executed` in milliseconds; gated rows park.
- **Debounced email.** Most decisions happen in-app while the user is active; firing an email immediately on every staging row would spam the inbox. The BullMQ delayed-job pattern reuses infrastructure we already have (`queue.add`, `queue.removeJobs`, ADR-0020's `notify()` fan-out). One Redis write per staging, one removal on in-app decision.
- **In-process cache + Pub/Sub bust for the policy.** Single-row PK lookups, ~50ns local. Multi-instance coherency rides ADR-0005's Pub/Sub bus on a `policy-bust:u:<userId>` channel — same shape as Replicache pokes, no new infra. Redis is NOT the policy store; the store is Postgres. Redis carries the invalidation signal only.

**Schema sketch.**

```sql
user_action_policies
  user_id            text primary key references users(id)
  default_mode       text not null default 'gated'       -- 'autonomy' | 'gated'
  integration_rules  jsonb not null default '{}'         -- IntegrationRules
  approval_notify_delay_ms integer not null default 300000
  updated_at         timestamptz default now()

action_stagings
  id                 text primary key                    -- 'as_<nanoid>'
  user_id            text not null references users(id)
  run_id             text not null references agent_runs(id)
  step_id            text not null
  tool_call_id       text not null                       -- AI SDK tool-call id from the LLM
  tool_name          text not null                       -- ToolName ('${IntegrationSlug}.${ActionSlug}')
  integration        text not null                       -- denormalized for queries
  risk_tier          text not null                       -- ToolRiskTier snapshot for UI/email copy
  proposed_input     jsonb not null
  proposed_input_hash text not null                      -- canonical hash for retry suppression
  requires_approval  boolean not null
  status             text not null                       -- pending|approved|rejected|expired|executed|failed
  decided_input      jsonb                               -- if user edited, the final input
  decided_at         timestamptz
  reject_reason      text
  executed_at        timestamptz
  execute_result     jsonb
  execute_error      jsonb
  expires_at         timestamptz                         -- per-tool default at staging time
  notify_after_at    timestamptz                         -- email-debounce scheduled fire time
  notified_at        timestamptz                         -- audit: did the email actually fire
  row_version        integer not null default 1           -- Replicache-visible pending approval rows
  created_at         timestamptz default now()
  updated_at         timestamptz default now()

  unique (run_id, tool_call_id)                          -- crash-resume idempotency
  index (user_id, status) WHERE status = 'pending'
  index (run_id)
  index (run_id, tool_name, proposed_input_hash) WHERE status = 'rejected'
```

**TypeScript shape** (canonical types live in `@alfred/contracts` — a new tiny package, zero Node deps, importable from `packages/db`, `packages/api`, `apps/web`; see CONTEXT.md):

```ts
export const POLICY_MODES = ['autonomy', 'gated'] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];

export const INTEGRATION_SLUGS = ['system', 'gmail', 'calendar', 'drive', /* ... */] as const;
export type IntegrationSlug = (typeof INTEGRATION_SLUGS)[number];

// Per-integration action lists feed a derived ToolName template-literal type:
export const SYSTEM_ACTIONS = [
  'load_integration',
  'spawn_sub_agent',
  'read_scratch',
  'write_scratch',
  'promote',
] as const;
export const GMAIL_ACTIONS = ['send_draft', 'read_message', 'search', /* ... */] as const;
export const CALENDAR_ACTIONS = ['create_event', 'list_events', /* ... */] as const;
export const INTEGRATION_ACTIONS = {
  system: SYSTEM_ACTIONS,
  gmail: GMAIL_ACTIONS,
  calendar: CALENDAR_ACTIONS,
  /* ... */
} as const;

export type ToolName = {
  [K in IntegrationSlug]: `${K}.${(typeof INTEGRATION_ACTIONS)[K][number]}`;
}[IntegrationSlug];

export const TOOL_RISK_TIERS = ['no_risk', 'low', 'medium', 'high'] as const;
export type ToolRiskTier = (typeof TOOL_RISK_TIERS)[number];

export type IntegrationRule = {
  mode: PolicyMode;
  toolOverrides?: Partial<Record<ToolName, PolicyMode>>;
};
export type IntegrationRules = Partial<Record<IntegrationSlug, IntegrationRule>>;
```

The Drizzle schema column uses `.$type<IntegrationRules>()` so the jsonb is compile-time typed at every read/write site.

Internal `system.*` tools are typed and audited through the same `ToolName` surface, but the default user policy seeds `system: { mode: 'autonomy' }`. They are not governed by `riskTier`; `riskTier` remains a UX hint for cards, summaries, and email copy. Retry suppression uses a canonical `hashToolInput(toolName, input)` helper from `@alfred/contracts`; the hash is stored on `action_stagings.proposed_input_hash` so rejection lookup is deterministic and indexed.

**Dispatch flow.**

```
boss-turn proposes tool call → dispatcher receives { toolName, input, runId, toolCallId }
  ↓
1. validate input against tool's zod schema
     → if invalid, synthesize validation-error tool-result; no staging
  ↓
2. check retry suppression
     proposedInputHash = hashToolInput(toolName, proposedInput)
     SELECT recent rejected row WHERE run_id=? AND tool_name=? AND proposed_input_hash=?
     → if found, synthesize rejected_by_user tool-result without re-staging or re-emailing
  ↓
3. resolve policy mode
     toolOverrides[toolName] ?? integration_rules[integration].mode ?? default_mode
  ↓
4. INSERT into action_stagings (status='pending', proposed_input_hash, risk_tier,
                                requires_approval=(mode==='gated'))
     ON CONFLICT (run_id, tool_call_id) DO NOTHING        -- crash-resume idempotency
  ↓
5a. requires_approval=false:
      invoke tool.execute(proposed_input)
        → UPDATE row (status='executed' | 'failed', execute_result/execute_error, executed_at=now())
        → return tool-result to boss

5b. requires_approval=true:
      emit SSE poke (kind='staging_pending', { stagingId, toolName, integration, riskTier })
      enqueue BullMQ delayed job (jobId=`staging-notify:${stagingId}`,
                                  delay=user_action_policies.approval_notify_delay_ms)
      call interrupt({ kind: 'hil', approvalId: stagingId, approvalKind: 'action_staging' })
        → run parks; boss-turn step yields with wakeCondition
```

On resume (via `signalRun({ runId, match: { kind: 'hil', approvalId: stagingId } })`):

```
load action_stagings row by stagingId
  ↓
case status:
  'approved' →
    invoke tool.execute(decided_input ?? proposed_input)
    UPDATE row (status='executed' | 'failed', execute_result/execute_error, executed_at=now())
    synthesize tool-result
      if decided_input != proposed_input → append meta.editedByUser=true
    return to boss

  'rejected' →
    synthesize { status: 'rejected_by_user', toolName, proposedInput, reason,
                 retryPolicy: 'do_not_retry_identical' }
    return to boss

  'expired'  →
    synthesize same shape as rejected, reason='auto-expired'
    return to boss
```

**UX surface.**

- **Policy editor** lives on the per-integration settings card. Radio: `Full autonomy` / `Gated` (the third tier `Per-tool config` is forward-compat in the schema but deferred from the v1 UI). Co-locates "what does this integration do?" with "how much do I trust it?"
- **Approvals page** at `/approvals`: Replicache-synced list of `status='pending'` rows, sorted by `created_at` desc, with a nav badge counter. Per-tool card components for high-stakes tools (gmail send, calendar create) live in a web-only registry keyed by `ToolName`; the web app must not import runtime values from `@alfred/api`. Generic JSON renderer fallback for tools without a custom card. Each card carries (a) tool name + risk-tier badge, (b) provenance link to the run + workflow, (c) editable proposed_input fields, (d) **Approve** / **Approve with edits** / **Reject (with required reason)** / **Reject and end run** buttons, (e) a banner with the most recent prior rejection of the same `(user_id, tool_name)` within N days if one exists.
- **Email** (debounced, default 5min): subject `[<risk_tier>] Alfred wants to <humanized tool name>`, body with key fields + a deep link to the in-app card. One email per staging row at v1; coalescing across a short window is a deferred optimization with no schema impact.
- **Default mode at signup**: `gated`. Conservative-by-default; asymmetric-risk argument — a wrong gate costs one click, a wrong send costs a relationship.

**Coexistence with `workflows.hil_gates`.**

`workflows.hil_gates` (ADR-0017) gates entire *steps* in explicit-DAG workflows; this ADR gates per-*tool-call* across both brief-only and DAG workflows. They coexist:

- A step listed in `workflows.hil_gates` parks via `wakeCondition.kind='hil'` referencing a step id. No staging row; the wake-payload marks this as a step-level approval.
- A tool call gated by user policy parks via `wakeCondition.kind='hil'` with `approvalId=stagingId` and `approvalKind='action_staging'`.
- Same primitive, two reference shapes; the runtime resolves by inspecting the wake-condition discriminator.

A workflow can hit both gates serially: step-level approval ("yes, do this phase") followed by tool-level approval inside the step ("yes, with these specific params"). Two pauses, distinct semantics, audit trail intact. m9/m10/m11 builtins don't populate `hil_gates` today, so there's nothing live to migrate.

**Audit log.**

`action_stagings` is the audit log. Every tool call (gated or autonomy) creates a row. Pending gated rows are Replicache-visible and therefore carry `row_version`; every approve/reject/expire/execute transition that changes a synced field increments it so `/approvals` removes resolved rows cleanly. Cross-join with `api_call_log` (ADR-0015) by `run_id` for per-action cost. "Show all actions Alfred took today" = `SELECT * FROM action_stagings WHERE user_id=? AND created_at > today ORDER BY created_at DESC`. No separate audit table.

**Out-of-scope, forward-compat slots.**

- **Per-parameter risk rules.** "Emails to my PA aren't risky; emails to my boss are." The right primitive is per-recipient/per-pattern predicates on the policy. v1 stays at per-tool resolution; the schema's `toolOverrides` value can widen from `PolicyMode` to `{ mode, predicates }` later without breaking change.
- **Agent self-modification of policy.** A `set_action_policy(integration, mode, toolOverrides?)` tool the boss can call (and which is itself `riskTier: 'high'` so changes are user-approved). Lets the user say "trust gmail entirely" in chat; boss stages the policy change; user approves; cache busts. Clean primitive when we get there.
- **Coalescing email notifications** across a short window (e.g. 60s). Additive: a `coalesce_window_seconds` setting + a worker tweak. No schema change required.
- **Presence-aware debounce threshold.** Longer threshold if the user is actively reviewing other staged actions. Additive lookup on `lastActiveAt`.
- **Custom lint rule** auditing `riskTier` classifications at PR time (anything called `delete_*`, `send_*`, `post_*`, `archive_*` must be `high` unless explicitly waived). Useful when the tool registry exceeds ~30 tools; v1 trusts the author.
- **Per-tool override UI** (the third Dimension tier). Schema is forward-compat; the dispatcher already reads `toolOverrides` if present; only the UI to edit it is deferred.

**Alternatives.**

- (a) **Synthetic `pending_approval` tool-result** (instead of pre-execute interrupt). Rejected — forces a fourth `TurnResult` case onto `AlfredAgent`, adds round-trips for the boss to reason about pending state, fights ADR-0006/0014's checkpoint model.
- (b) **Plan-then-execute two-tool dance** (`plan_send_email` returns id; user approves externally; boss calls `execute_pending(id)`). Rejected — doubles tool-call cost on every gated action; no audit/visibility gain over the staging-table approach.
- (c) **Per-tool staging tables** (ADR-0014's `SlackPost`-style). Rejected — approval UI has to UNION across N tables; one generic table is simpler and supports the SSE poke pattern.
- (d) **Stage in `agent_run_context.scratch.staging.*`.** Rejected — scratchpad has 7-day TTL and is per-run; cross-run "all pending approvals" query becomes impossible.
- (e) **Reuse `events_outbox`** for staging. Rejected — outbox is broadcast/fan-out, not decision-bearing state. Wrong primitive.
- (f) **Hardcoded per-tool risk gates** (system always requires approval for `riskTier='high'` regardless of policy). Rejected — paternalism. User owns the policy. ADR-0001's single-user framing makes "system protects future-you from current-you" hostile, not helpful.
- (g) **Email-reply-based approval.** Rejected by ADR-0019 ("Email-reply parsing deferred"). Email is the notification surface; the in-app card is the decision surface.
- (h) **Always cache the policy in Redis.** Rejected — in-process Map is ~20,000× faster than Redis GET; Redis adds latency without benefit at the read path. Redis carries the Pub/Sub bust signal only.

**Open.**

- Initial sub-set of integrations + per-action lists that ship with `@alfred/contracts` at first cut. Intent: every integration that ships a `liveTool` registers its slug + actions in contracts; backfill Gmail as part of m13a.
- Whether the `policy-bust:u:<userId>` channel rides alongside ADR-0005's existing kinds or as a sibling Redis Pub/Sub channel. v1 plan: sibling channel; revisit if outbox kinds prove the right home.
- Threshold default (5min) is a UX guess. Worth dialing once we have real usage signal; the column + settings field already exist.

**Amendment (2026-05-27) — chat "auto mode" = run-scoped autonomy override; Workspace write tools namespaced per-app.**

Two refinements landed while planning the write-surface expansion (ADR-0043/0044):

1. **Chat auto-mode is a run-scoped autonomy override, not a fourth policy concept.** The composer's existing `autoMode` toggle (`dimension-chat-thread.tsx`, "auto mode" / "manual review") ultimately persists onto the thread/conversation row, but the dispatcher should only see a run-scoped policy override copied from that thread at run creation. That override sits at the **top** of policy resolution: `run-scoped auto-mode override → per-tool override → per-integration mode → user default`. "Auto mode" = blanket `autonomy` for that run/thread (no riskTier carve-outs — ADR-0034 alt-(f) holds); "manual review" = honor the durable policy. The override is **server-authoritative once a run exists** because the gate runs server-side and background runs have no browser. `localStorage`/global client state holds only the **default toggle position for new chats**, default **manual** (preserves the conservative-default asymmetry). Implementation rides the m13 chat→runtime bridge; the dispatcher's resolution order accepts the optional run-scoped override without assuming a thread table already exists.

2. **Workspace write tools are namespaced per Google app.** `docs` / `sheets` / `slides` are distinct `LoadableIntegrationSlug`s (add `sheets`, `slides`); tools read `docs.create`, `sheets.create`, `slides.create`, etc. This gives self-describing names, per-app `@`-mentions, and per-app policy granularity (`slides: autonomy` while `gmail: gated`), even though all four ride the one shared Google credential and the single `drive.file` scope (the editor APIs honor `drive.file` for app-created files). `create_*` returns `{ fileId, webViewLink }` and never auto-shares/sends — broadening visibility (`drive.share`) or sending (`gmail.send`) are separate, separately-gated tools. `riskTier`: `create_*` → `low`, `share`/`send` → `high` (UX hint only).

**Amendment (2026-05-31) — approvals read models: pending queue is Replicache-synced + client-filtered; history is a deferred server-paginated read model.**

The `/approvals` UI splits into two surfaces with deliberately different data paths. **(1) The live pending queue** is Replicache-synced (`status='pending' AND requires_approval`) and bounded (rows auto-expire at 24h), so pagination and filtering (integration + risk facets) run **client-side** over the synced collection — filter state in URL search params, "pagination" is windowing not server paging. No server query endpoint backs this surface; adding one would duplicate the Replicache model for a real-time queue. **(2) History** (resolved actions — approved/rejected/expired) is *not* synced and grows unbounded, so it is a separate **server-paginated + filterable** read model (`GET /approvals?status=&integration=&risk=&page=`), **deferred** until the History tab lands. The card also gains derived provenance on the synced row (`workflowName`, narrowed `trigger`, truncated `brief`); the per-`ToolName` card registry stays a web-only `Partial` map with a generic fallback, and the four decision actions remain uniform across tools. Full implementation slice in [`docs/plans/m13-plan.md §5f`](./docs/plans/m13-plan.md).

---

## ADR-0035 — Transcript compaction: cheap-tier handoff summary at 60% threshold

**Decision.** When a boss run's transcript token-count exceeds 60% of the resolved model's context window, the executor inserts a dedicated `compact-transcript` step between `dispatch-tools` and the next `boss-turn`. The step calls a cheap-tier compactor (`getCheapModel()`) to produce a structured XML **run handoff** that replaces older transcript messages while preserving the in-flight tail (most recent assistant message + its tool calls + their results). The stable boss system prompt and tool definitions remain outside `agent_runs.transcript` as `AlfredAgent.turn()` inputs. The handoff captures `goal`, `user_directives`, `decisions`, `actions_completed`, `actions_rejected`, `actions_failed`, `sub_agent_findings`, `pending_followups`, `key_entities`. Sub-agents do not compact — they fail back to the boss for re-decomposition (ADR-0026).

**Why.**

- **Quality, not headroom.** Long-context quality degrades materially before the hard limit (200K-window models around 120-150K; 1M-window models around 400-600K — empirically observed across both Claude and Gemini families). Compacting at 60% keeps the working window in the high-quality region rather than chasing token-counting efficiency. Cost differential of more frequent cheap-tier calls is negligible at single-user scale; quality difference is not.
- **No verbatim "last N" preservation.** A 30K-token tool result in the recent tail would defeat compaction's purpose. The minimum the boss needs to continue mid-step is system + tools + the immediately-prior assistant message and its tool results — the in-flight tail. Everything older compresses into the handoff.
- **XML over JSON for the handoff.** Anthropic explicitly recommends XML for nested-structure prompts; the model parses sections more reliably; less syntax noise per token on tool-call records. Schema is fixed (compactor's job is to fill slots), not free-form (which would lose structure across compactions).
- **Cheap-tier compactor, structurally bounded.** `getCheapModel()` (Haiku 4.5 / Gemini 2.5 Flash via the ADR-0016 dispatcher); output capped at 2000 tokens. Each `<action>` becomes one short line — IDs and outcomes kept, narrative dropped.
- **Distinct executor step, not inline.** Compaction is state management, not a tool call. Putting it in the executor between `dispatch-tools` and `boss-turn` makes it a real checkpoint (durable-resume compatible) and keeps `AlfredAgent.turn` free of compaction concerns. Also preserves ADR-0015's "one LLM round-trip = one `api_call_log` row" — the compactor is its own metered call with `attribution.role='compactor'`.

**Run handoff schema.**

```xml
<run_summary>
  <goal>One-line restatement of what this run is trying to accomplish.</goal>

  <user_directives>
    <!-- Mid-run intent statements that bound the agent's future behavior:
         scope grants, integration trust changes, redirections.
         Verbatim, not paraphrased. Pragmatic, not epistemic. -->
    <directive>e.g. "User said 'trust gmail entirely for this conversation' at turn 3."</directive>
  </user_directives>

  <decisions>
    <!-- Facts, preferences, or constraints learned during the run. Epistemic. -->
    <decision>e.g. "Alice is the engineering manager (confirmed via signature in thread #42)."</decision>
  </decisions>

  <actions_completed>
    <action tool="gmail.search" key_output="found 3 threads from alice@..." />
  </actions_completed>

  <actions_rejected>
    <action tool="gmail.send_draft" reason="user said 'already replied to this thread'" />
  </actions_rejected>

  <actions_failed>
    <action tool="..." error="..." />
  </actions_failed>

  <sub_agent_findings>
    <finding sub_id="sub_a" key_output="..." />
  </sub_agent_findings>

  <pending_followups>What the boss said it would do next.</pending_followups>

  <key_entities>
    <entity name="Alice" id="alice@..." context="manager; brought up in 3 threads" />
  </key_entities>
</run_summary>
```

**`<user_directives>` is the load-bearing slot.** Without it, mid-run policy changes ("just trust gmail for the rest of this conversation") evaporate after the next compaction and the boss starts re-asking for approval. ADR-0034's forward-compat `set_action_policy` tool will eventually persist these to `user_action_policies` properly; until then, the handoff carries the directive forward within the run. The distinction between `<user_directives>` (pragmatic — what the user wants) and `<decisions>` (epistemic — what's true) matters because the boss reasons differently about each: directives bound behavior, decisions bound belief.

**Executor flow.**

```
boss-turn (proposes tools)
  → dispatch-tools (results land in transcript)
    → executor measures tokenCount(agent_runs.transcript)
       if tokenCount > compactionThresholdTokens(model.contextWindow):
         → compact-transcript
            ├── identify in-flight tail (`state.inFlightTailStart` → transcript end)
            ├── invoke cheap-tier compactor with prior transcript
            ├── compactor emits <run_summary>
            └── rewrite agent_runs.transcript to [<summary>, in-flight tail]
       → boss-turn (consumes results / summary)
```

In-flight tail identification rule: `boss-turn` records `state.inFlightTailStart = transcript.length` immediately before appending the assistant message/tool calls for that turn. `compact-transcript` preserves `transcript.slice(state.inFlightTailStart)` verbatim and feeds everything before it to the compactor. Deterministic, bounded by one iteration's worth of messages, and does not require per-message metadata.

**Compactor invocation contract.**

```ts
const result = await meteredGenerateText({
  model: getCheapModel(),
  attribution: { kind: 'llm', role: 'compactor' },     // per m13 plan
  maxOutputTokens: 2000,
  system: COMPACTOR_SYSTEM_PROMPT,
  messages: priorTranscriptToCompact,
});
nextTranscript = [
  { role: 'system', content: `<run_summary>${result.text}</run_summary>` },
  ...inFlightTail,
];
```

`COMPACTOR_SYSTEM_PROMPT` (sketch, subject to prompt-engineering pass): "Summarize the transcript below into the schema. Maximum 2000 tokens. Drop verbatim text; keep IDs, decisions, user directives, every approved/rejected/failed action with its outcome, every sub-agent finding. **Preserve mid-run user intent statements verbatim under `<user_directives>`; do not paraphrase.** Each `<action>` is one short line."

**Cache interaction.**

ADR-0026's two ephemeral `cacheControl` breakpoints sit on the stable system prompt and the last tool definition; both survive compaction because they are supplied outside `agent_runs.transcript`. After compaction, place a **third** ephemeral breakpoint immediately after the `<run_summary>` system note in the transcript. Anthropic allows up to 4 breakpoints per request (ADR-0026 footnote explicitly called out compaction as the trigger to use the third).

- Immediate next turn after compaction = cache miss on the message-history portion. Expected; the alternative is context-overflow failure.
- Subsequent turns hit the new stable prefix (system + tools + `<summary>`). Each new turn appends to the in-flight tail, hitting the cache up through the summary breakpoint.
- Next compaction invalidates the third breakpoint; cycle continues.

**Implementation notes.**

- **`model_prices.context_window`** column added. Seeded from `models.dev` by `pnpm --filter @alfred/db db:sync-prices` (ADR-0016). The executor resolves `model.contextWindow` from this column rather than hardcoding per-SKU.
- **Token counting** uses AI SDK's tokenizer (or `@anthropic-ai/tokenizer` for Anthropic models). Approximation within ~5% is acceptable for threshold purposes — we have 5% slack on either side of the 60% boundary.
- **Threshold constant** lives in `@alfred/contracts`:
  ```ts
  export const COMPACTION_THRESHOLD_PCT = 0.60;
  export const compactionThresholdTokens = (modelContextWindow: number) =>
    Math.floor(modelContextWindow * COMPACTION_THRESHOLD_PCT);
  ```

**Fault behavior.** Compactor call failure triggers a **bounded in-step retry** — 3 attempts with 100ms then 200ms backoff inside the `compact-transcript` step body. On terminal exhaustion the run fails with `error.message='compactor_failed: <last error>'`. Explicit failure beats degraded behavior (running with overflowing context = hallucination or silent truncation). The retry lives in the step rather than relying on the executor's per-attempt counter so a transient cheap-tier blip doesn't burn a whole run attempt; the executor's idempotency (per ADR-0014) still covers worker-crash recovery, narrowing the double-charge window to a single in-flight cheap-model call (~$0.0001) — matching every other LLM step in the system. Three local attempts is also enough headroom that persistent failure surfaces as a real bug rather than a flapping retry loop. **Per-run dollar budget for runaway loops is the orthogonal concern handled by ADR-0046** (sibling, deferred from m13); the 30-turn cap in `userAuthoredBriefWorkflow` is the structural ceiling in the meantime.

**Sub-agents do not compact.** Per ADR-0026, a sub-agent approaching its context window is evidence the brief was too broad; the right answer is failing back to the boss for re-decomposition, not soldiering on with a degraded view. No compactor invocation inside a sub-agent run. The boss's own "compaction" of sub-agent output happens at the scratchpad/`promote` boundary per ADR-0016 — that's a different mechanism (synthesis at the agent-tree edge) than transcript compaction (in-flight reduction within a single agent's context).

**Alternatives.**

- (a) **In-run compaction at 80% threshold (Dimension's value).** Rejected — long-context quality degrades materially earlier; 60% keeps the working window in the high-quality region. Empirical, not theoretical.
- (b) **Preserve "last N message pairs" verbatim alongside the summary.** Rejected — a 30K-token tool result in the recent tail defeats compaction. The in-flight tail is bounded by one iteration's worth of work; "last N pairs" is unbounded.
- (c) **JSON schema for the handoff.** Rejected — Anthropic recommends XML for nested-structure prompts; XML parses more reliably across long structured sections; less syntax noise per token on tool-call records.
- (d) **Inline compaction inside `AlfredAgent.turn`.** Rejected — conflates LLM concerns with state management; breaks durable-resume; violates ADR-0015's "one LLM round-trip = one `api_call_log` row" (compaction would silently happen inside a single charge-and-log boundary).
- (e) **Cost-triggered compaction** (e.g. compact when run spend exceeds $X). Rejected for v1 — orthogonal concern (budget enforcement, not quality preservation). The `model_prices.context_window` column gives us the hook for a richer trigger later if needed.
- (f) **Post-run conversation summary** (Dimension's platform-specific thresholds). Deferred — no long-lived chat surface yet at Alfred v1; revisit when the composer (post-m13) ships substantial user conversations worth preserving across runs.

**Open.**

- The compactor system prompt is sketched, not engineered. A real prompt pass with long runs to test against lands with m13a.
- 2000-token output cap is a v1 guess. Worth dialing once real runs accumulate.
- Whether the boss's own system prompt should include explicit guidance to restate received user intent as future-compaction-friendly directives ("when the user expresses an intent that bounds your future behavior, restate it succinctly so it survives compaction"). Leaning yes; lands with the boss system prompt design in m13a.

**Amendment (2026-06-01) — compactor decoupled from `getCheapModel()` to Sonnet 4.6 (thinking off); threshold uses `min(boss, compactor)` window.**

The 7f prompt-engineering pass forced the compactor's model identity, which surfaced two issues the original ADR glossed.

- **Model: Claude Sonnet 4.6, extended thinking disabled** (`providerOptions.anthropic.thinking: { type: 'disabled' }`). The ADR body and `compactor.ts` used `getCheapModel()` (today `gemini-2.5-flash-lite`). Reconsidered against the compactor's actual profile: it fires *rarely* (only past threshold), is *latency-tolerant* (a background mid-run step), and is *quality-critical* (a botched handoff corrupts the entire remainder of the run). On that profile cost and speed are nearly free axes; the only axis that matters is structured-output + instruction-following reliability — exactly where flash-lite is weakest (Artificial Analysis Intelligence Index ~13; the `assertRunSummary` code-fence-tolerance hack is direct evidence it fights the envelope). Sonnet 4.6 leads on instruction-following / verbatim discipline; thinking is disabled because the compactor is a mechanical transform, not a reasoning task, so thinking tokens are pure waste. A compaction costs cents regardless, so the ~3× price over Haiku and the latency delta are immaterial. **Not a new tier dispatcher** (no `getCompactorModel()`): the model is a shared `COMPACTOR_MODEL` constant, imported by both the compactor call and the threshold math (which needs the compactor's window).
- **Fallback: Gemini 2.5 Flash** (II ~27, 1M context), *not* flash-lite. Flash-lite (II ~13) is below the acceptable quality floor for the handoff. Flash's 1M window also means it never *shrinks* `min()` (below), so it doubles as the overflow-escape route.
- **Threshold = `compactionThresholdTokens(Math.min(bossWindow, compactorWindow))`**, both windows resolved from `model_prices.context_window`. The body's `compactionThresholdTokens(model.contextWindow)` read only the boss window. That breaks the moment the compactor's window is smaller than the boss's — which is true *right now*: during the provider-swap window the boss is `gemini-2.5-pro` (1M → 600k threshold) while the compactor is Sonnet (200k). A 600k prior slice cannot be ingested by a 200k model. `min()` is therefore unconditional, not GPT-conditional. Applied at **both** call sites in `userAuthoredBriefWorkflow`: the pre-compaction trip-wire and the post-compaction Guard 3 overflow check (the latter previously thresholded on the boss window, which let a large in-flight tail pass and then overflow the compactor one turn later).
- **New pre-call guard: prior slice must fit the compactor window.** Before invoking the compactor, estimate `priorTokens`. If `priorTokens > compactorWindow`, escalate to `COMPACTOR_FALLBACK_MODEL` (Gemini Flash, 1M); if it exceeds even the fallback window, fail with `compactor_input_too_large`. This directly asserts the ingest invariant rather than trusting the threshold math, and covers the pathological case where a single high-payload turn's in-flight tail becomes `prior` on the next turn. Tiered (fallback → fail) beats a flat fail: accept one lower-quality compaction to survive rather than killing the run.

This supersedes the `getCheapModel()` references for the compactor throughout this ADR and resolves the first "Open" item's model question. The in-flight-tail rule, the `<user_directives>`-verbatim contract, the third cache breakpoint, and the bounded-retry fault model are all unchanged.

**Schema addition — directive supersession.** `<directive>` gains an optional `superseded="true"` attribute. The body said "preserve every mid-run user intent statement verbatim," which, taken literally, retains both a directive and its later revocation with no signal which is current — so the boss can act on revoked permission. New contract: keep every directive verbatim in chronological order; when a later directive conflicts with / overrides an earlier one, tag the earlier with `superseded="true"`. The marker is metadata, so "verbatim" still holds (the quote text is untouched); the boss acts only on non-superseded directives. Nothing is dropped (audit intact) and a revoked *intent* is **not** demoted to `<decisions>` (it isn't an epistemic fact). Proven by the `superseded-directive` fixture (m13 Phase 7f).

**Fault model addition — overflow is not the same as failure.** Two distinct paths: a compactor *call* failure (model error / invalid envelope) takes the existing bounded retry → `compactor_failed`; a *prior-slice-too-large* condition first falls over to `COMPACTOR_FALLBACK_MODEL` (1M window) and only fails with `compactor_input_too_large` when the slice exceeds even the fallback. The latter is the single place a degraded (lower-quality) compaction is accepted — surviving a pathological high-payload turn beats killing the run. This refines the body's blanket "no degraded fallback" line, which predated the asymmetric-window reality.

---

## ADR-0036 — Redis as scratchpad primary; Postgres as terminal snapshot

**Decision.** During a boss run, all scratchpad reads and writes go to Redis (`alfred:scratch:{runId}:{zone}.{path}` keys, 30-day TTL at insert). On terminal state — success, failure, or cancellation — the executor's terminal step copies the full Redis-side scratchpad into the `agent_run_context` table as per-key rows (one INSERT per key, idempotent via `ON CONFLICT (run_id, key) DO UPDATE`). Live writes pay Redis latency (~1ms on Railway's private network); audit/replay/cross-run queries hit Postgres. Mid-run Redis loss recovers via idempotent step re-execution per ADR-0014 — same shape as any other transient failure.

**Supersedes part of ADR-0016.** ADR-0016 said *"no Redis for this layer: at single-user scale, Postgres handles per-run K/V trivially."* That was correct at decision time; m13's design pressure surfaced two issues: (a) sub-agent fan-out wants fast inter-agent reads for the boss's synthesis pass (Dimension's "sub-millisecond reads"), and (b) per-key Postgres writes cost a network round-trip per scratch op where Redis costs a fraction. ADR-0036 keeps ADR-0016's *pattern* unchanged (namespaced scratchpad, boss-promotes-to-shared, single-writer-per-zone, no sub-sub-agents, sub-agents don't compact) and changes only the *store layer*.

**Why this composition.**

- **Speed where it matters.** Live inter-agent reads during a run hit Redis. The hot path — sub-agents writing findings + the boss reading them — runs at private-network latency.
- **Durability where it matters.** Audit queries ("everything Alice was mentioned in last week") hit Postgres. Cross-run reads use the same store the runtime checkpoints to. No "which store is canonical" ambiguity outside the run lifetime.
- **Composes with the durable runtime.** ADR-0014's idempotent steps are the recovery primitive for mid-run Redis loss. No new recovery semantics required — a lost scratch entry re-executes its producing step on the next executor wake.
- **Single source of truth at every moment.** During the run: Redis. After terminal step: Postgres. Clean transition.
- **No data migration cost.** `agent_run_context` schema is unchanged. m13 builds the Redis-primary path from day one; no parallel-write phase.

**Key shape.**

```
alfred:scratch:{runId}:shared.{path}             -- e.g. alfred:scratch:run_abc:shared.alice_email
alfred:scratch:{runId}:scratch.{subId}.{path}    -- e.g. alfred:scratch:run_abc:scratch.sub_a.findings
```

The `alfred:scratch:` prefix namespaces against the existing Redis use (BullMQ queues, ADR-0005 Pub/Sub, session-cache, ADR-0034's `policy-bust:u:{userId}` channel). Two distinct builders in `@alfred/contracts`, not one variadic helper — so call sites cannot accidentally target the wrong zone:

```ts
export const sharedKey = (runId: string, path: string) =>
  `alfred:scratch:${runId}:shared.${path}` as const;
export const subAgentKey = (runId: string, subId: string, path: string) =>
  `alfred:scratch:${runId}:scratch.${subId}.${path}` as const;
```

**Value envelope.**

```ts
export type ScratchEntry<T = unknown> = {
  value: T;
  zone: 'shared' | 'scratch';
  writtenBy: string;        // 'boss' or `${subId}`
  writtenAt: number;        // epoch ms
};
```

Stored as JSON-serialized via `SET key value EX 2592000`. The generic at the call site (`read_scratch<TFindings>(key)`) lets callers narrow the value type. Per-zone single-writer is enforced at the dispatcher (a child run's `write_scratch` tool can only target its own `scratch.{subId}.*` keys; the boss's tool only targets `shared.*`) — not at the type system.

**TTL: 30 days at insert.**

- Live runs can pause for HIL hours or days (ADR-0014's durable-resume); a short TTL would expire mid-pause.
- "Delete on terminal step" was rejected — terminal-step cleanup needs idempotency against crash-retry; not deleting at all sidesteps that class of bug entirely.
- 30 days > (longest realistic HIL pause + 7-day post-completion audit hot window) with margin.
- Memory pressure at single-user scale is a non-concern: hundreds of runs/day × kilobytes of scratch = single-digit MB total.

**Snapshot to Postgres at terminal step.**

Schema unchanged from ADR-0016:

```sql
agent_run_context
  run_id      text references agent_runs(id)
  key         text
  value       jsonb
  zone        text                -- 'shared' | 'scratch'
  written_by  text                -- 'boss' or '{sub_id}'
  written_at  timestamptz
  primary key (run_id, key)
```

Terminal-step semantics (pseudocode):

```ts
await db.transaction(async (tx) => {
  const keys = await redisClient.scan(`alfred:scratch:${runId}:*`);
  for (const key of keys) {
    const raw = await redisClient.get(key);
    if (!raw) continue;
    const entry: ScratchEntry = JSON.parse(raw);
    const subKey = key.replace(`alfred:scratch:${runId}:`, '');
    await tx
      .insert(agentRunContext)
      .values({
        runId,
        key: subKey,
        value: entry.value,
        zone: entry.zone,
        writtenBy: entry.writtenBy,
        writtenAt: new Date(entry.writtenAt),
      })
      .onConflictDoUpdate({
        target: [agentRunContext.runId, agentRunContext.key],
        set: { value: sql`excluded.value`, /* etc */ },
      });
  }
});
```

`ON CONFLICT DO UPDATE` makes the snapshot idempotent against terminal-step retry (a crash between "scan Redis" and "transaction commit" replays cleanly).

**Atomicity.**

- Single-key writes are atomic by Redis semantics.
- Compound writes (a sub-agent writing `findings.x` and `summary` in one logical batch) are caller's responsibility — use MULTI/EXEC if atomicity matters. Most cases are single-key.
- `promote(scratchKey)` (ADR-0016's primitive — copy `scratch.{subId}.foo` to `shared.foo`) is implemented as read-then-write; not atomic. Single-writer-per-zone (only the boss writes `shared.*`, only `sub_a` writes `scratch.sub_a.*`) makes this race-free in practice.

**Failure modes.**

- **Redis unavailable** → scratchpad ops throw `RedisUnavailableError` → step fails → durable-resume retries on the next executor wake. Same shape as Postgres-down.
- **Network partition** → same as Redis-down.
- **Stale Redis reads** → not possible under our access pattern (single-writer per zone enforced at the dispatcher).
- **Terminal-step snapshot fails** → the run's terminal state is still set, but the Postgres mirror is incomplete; a follow-up `snapshot-retry` sub-step re-attempts on the next executor wake. Pure idempotent retry; no impact on user-facing state.

No circuit breakers, no fallbacks. Redis is a hard dependency at the same level as Postgres.

**Migration.**

- No data migration. `agent_run_context` schema is unchanged.
- Existing builtin workflows (m9/m10/m11) don't write to the scratchpad — they're explicit-DAG step workflows, not boss-agent runs.
- m13 builds the Redis-primary path from day one; no dual-write phase.

**Alternatives.**

- (a) **Pure ephemeral (Redis only, no Postgres mirror).** Rejected — post-completion audit becomes a 7-day TTL race. The single snapshot at terminal step is cheap and preserves the cross-run query surface.
- (b) **Dual-write to both stores on every scratch op.** Rejected — doubles write cost on the hot path for marginal gain. Dual-write is correct when both stores are *concurrently* live; for per-run intermediate state with a clean terminal handoff, it's twice the work for no benefit.
- (c) **One jsonb blob per run** (single `data jsonb` column instead of per-key rows). Rejected — saves nothing material, gives up SQL ergonomics for cross-run queries.
- (d) **Postgres unchanged from ADR-0016 (no Redis).** Rejected on empirical grounds — m13's sub-agent fan-out + boss-synthesis pattern wants sub-ms inter-agent reads; Postgres at 1-3ms per op multiplied across a boss read pass over N sub-agent findings adds material latency to the user-facing boss turn.
- (e) **Keep Redis keys live indefinitely (no TTL).** Rejected — leak risk on abandoned runs; 30-day TTL gives natural eviction without orchestration-layer cleanup.
- (f) **Delete Redis keys at terminal step.** Rejected — couples cleanup to terminal-step idempotency in a way that introduces a real failure class (partial-delete + retry = inconsistent state). Letting TTL handle eviction is simpler and equivalent in outcome at our scale.

**Open.**

- Whether the boss's synthesis read pass should `SCAN` for `scratch.{subId}.*` keys per run, or maintain a per-sub_id index list in Redis. v1: SCAN with pattern (`SCAN MATCH alfred:scratch:{runId}:scratch.*`) — at single-user scale, scratch counts per run are in the low tens. Revisit if profiling shows SCAN dominating.
- Whether the snapshot step should store a Redis SCAN cursor or completion marker so a retried snapshot doesn't re-read already-landed keys. v1: `ON CONFLICT DO UPDATE` makes re-reads safe; explicit cursor is an optimization that only matters at thousands of scratch entries.

---

## ADR-0037 — Gmail realtime ingestion via `messages.list`; `history.list` demoted to catch-up

**Decision.** The webhook path (pub/sub push → ingest) is rebuilt on `users.messages.list?q=newer_than:5m` + per-id `messages.get`, deduped against the existing unique index on `documents.(user_id, source, source_id)`. `users.history.list` stops being the realtime primitive and is demoted to the 5-min poll-fallback sweep + the initial-sync seed, where it earns its keep. A new BullMQ job kind `gmail.poll_recent` carries the realtime path; the webhook handler enqueues it, and `gmail.poll_history` retains the cursor-based delta logic for catch-up only.

**Why this is its own ADR.** ADR-0024 chose the watch+history.list pattern (the Gmail-canonical realtime shape) and ADR-0032 added burst dedup over it. Neither questioned the implicit assumption that pub/sub-notified history pages would *contain* the just-arrived message. They don't, reliably. The 2026-05-22 latency study (`email_triage` joined to `documents` over the prior 24h, n=29) showed avg `ingestion_lag_s` = 30.7s but p90 = 117.8s, p95 = 197.3s, max = 222.2s — entirely driven by webhook history pages returning label/system events with no `messagesAdded` and the cursor advancing anyway. The user-perceived case: a GitHub `Sudo email verification code` took 195s to ingest and 4.5s to classify; the classifier was never the bottleneck. ADR-0037 names the root cause as a wrong-primitive choice in ADR-0024 — not a tunable parameter on the existing path.

**Why `messages.list` is the right realtime primitive.**

- `users.history.list` is a change-log API with its own indexing pipeline. Pub/sub fires from one pipeline; history is populated from another. The two are eventually consistent, with the gap measured in seconds-to-minutes for the very write that triggered the push.
- `users.messages.list` queries Gmail's search index — the same surface the web UI's search box hits. Empirically that index updates within seconds of a message arriving and is what Gmail's own client treats as "live."
- A `q=newer_than:5m` window returns ≤ tens of ids in single-user steady state; the existing `documents_source_id_idx` dedupes anything we already have.

**Path layout after this ADR.**

```
Realtime (new — gmail.poll_recent):
  trigger:   pub/sub push → /webhooks/gmail
  primitive: users.messages.list?q=newer_than:5m  (capped to 50)
  per id:    skip if (userId, source, sourceId) exists; else
             messages.get + persist + embed + enqueueTriage
  cursor:    advance to max(message.historyId) observed, monotonic only
  dedup key: gmail.poll_recent.{credId}  (30s TTL, ADR-0032 shape)

Catch-up (kept — gmail.poll_history):
  trigger:   5-min poll-sweep (gmail.poll_sweep finds cursors > 5min old)
  primitive: users.history.list from stored cursor
  role:      backstop for anything realtime missed — bursts > 50, dropped
             pushes, multi-minute outages. Fans triage on any inserts.
  dedup key: gmail.poll_history.{credId}  (separate from realtime — both
             paths can run concurrently without one starving the other)

Initial-sync seed (unchanged — gmail.ingest_recent):
  trigger:   OAuth callback (small seed) + history-cursor-gone fallback
  primitive: users.messages.list with broad query (newer_than:30d)
  role:      cold-start, full re-ingest after a 404 from history.list.
```

The realtime path advances the history cursor monotonically (only forward, only if higher than current) so the catch-up path doesn't re-fetch already-ingested messages. The inverse race (catch-up moves cursor while realtime is mid-flight) is harmless because every `persistMessage` is idempotent against `(userId, source, sourceId)`.

**Why we don't replace `history.list` entirely.**

- `history.list` is the right shape for catch-up after downtime — a 12-hour outage's worth of deltas is one paged call, not a 12-hour-wide `newer_than` window.
- The poll-fallback was always the backstop; that role doesn't change.
- Initial-sync after a `historyId-gone` 404 needs a defined cursor to start from. `messages.list` has no comparable "from this id forward" semantic.

**Path we did not take: empty-page retry on `history.list`.** The first draft of this ADR proposed a 20s retry whenever a webhook-triggered `gmail.poll_history` returned `inserted=0 skipped=0` with the cursor advancing. That would have moved p95 from ~200s into the ~25s band — useful, but a bandaid: it doesn't change the underlying API choice, it only papers over the latency by repeating the wrong-primitive call. We chose the structural fix instead because the PR was already off main with its own review surface, the realtime path is small enough to land in one pass (a ~140-line new function reusing every helper from `ingestRecentGmail`), and 25s is still not the product target.

**Trade-offs being accepted.**

- One additional Gmail API call on the realtime path compared to history.list (≈5 quota units for `messages.list`). At ≤100 webhooks/day per credential this is ≤500 units against a 1B/day quota — non-issue.
- `messages.list` skips spam/trash by default; `history.list` did not. Acceptable for triage: we don't want to label spam. If a future workflow needs spam visibility, it can opt in via `q=newer_than:5m in:anywhere`.
- The realtime path's 5-min `newer_than` window will miss a burst of >50 messages arriving for one credential inside 5 min. At single-user scale this is essentially never; the catch-up sweep will pick up the overflow within 5 min.
- Webhook and catch-up paths now use distinct dedup keys, so both can fire for the same credential inside 30s. Cheap: `persistMessage` dedupes, the catch-up's history.list only walks the cursor delta (small), and triage only fires on actual inserts.

**Pipeline shape on the realtime path.** The job handler runs `pollGmailRecent` → `enqueueTriageRuns` → `embedDocument` (in that order). Triage is enqueued *before* embedding so the classifier worker can start working while Voyage is still hitting the wire. Triage reads the `documents` row, not `chunks`, so an in-flight embed is irrelevant to it. Embed is best-effort here; `gmail.embed_sweep` is the safety net for any embed that fails. Inside `pollGmailRecent` itself the three header loads (cred + token + cursor) run in parallel, an indexed `SELECT ... WHERE source_id = ANY(...)` skips `messages.get` for ids we already have, and the remaining per-message fetch+persist runs at concurrency 5. Triage enqueues fan in parallel too — N triage `createRun + enqueueRun` pairs take one DB+Redis roundtrip rather than N.

**Expected impact.** Predicted p95 total tag latency ≈ 6–8s steady state (pub/sub ~1s + messages.list ~1s + messages.get + persist ~1.2s + triage enqueue ~0.1s + classify ~4s). Embed (~200ms–2s once Voyage is live) is no longer on the critical path. Median was already 8.5s; this collapses the long tail. Verify with a fresh `email_triage` ⨝ `documents` aggregation after a week of production traffic.

**Trace back to the symptom.** 2026-05-22 ~10:24 IST: user reports a GitHub Sudo verification code took ~3 min to be tagged. Logs show the webhook fired at 04:54:06 UTC with `inserted=0 skipped=0` and the cursor advancing 73 ticks (label/system events only); the same message was finally ingested at 04:57:34 UTC on a subsequent webhook and tagged 4.5s later. Median tag latency for the same user in the prior 24h: 8.5s. This ADR replaces that webhook-triggered call with `messages.list`, which sees fresh sends within seconds rather than minutes.

---

## ADR-0038 — Content-at-rest posture: vendor crypto only, no app-layer encryption

**Decision.** No app-layer encryption on user content (`documents.content`, `chunks.content`, `attachment_pages.extracted_text`, `memory_facts.value`, briefing bodies, `email_sends.body`). Three concrete layers stand in:

1. **Vendor at-rest encryption** — Railway managed Postgres + Redis + object storage all encrypt disks/volumes at the provider layer. Already on, free.
2. **Log redaction** — Pino redactor + Sentry `beforeSend` scrubber for known sensitive field paths so accidental `console.log`, error breadcrumbs, and event payloads never carry plaintext content.
3. **Don't persist raw payloads** — `documents.raw` (the Gmail MIME tree) drops. Re-extraction means re-fetching from Gmail; Gmail is the durable copy.

**Why.** At single-user scale on a single Railway project, an app-layer key has exactly two homes:

- **(a) Railway env next to the DB.** The key and the ciphertext share a blast radius. An attacker who can pull a backup or read `DATABASE_URL` can also pull `ALFRED_CONTENT_KEY`. The encryption is ceremonial — it adds schema complexity (`_iv` + `_kid` columns on every content field, an `enc/dec` boundary on every write/read path) for ~zero real-world delta.
- **(b) Outside Railway** (1Password CLI / Mac Keychain pulled on boot). Real protection — the key never sits next to the ciphertext. But it's an operational tax (boot dependency on a secret-fetch step, dev-env gymnastics, key-rotation runbook) for a threat surface that doesn't yet exist on this project: no contractors, no analytics pipeline, no regular backup-export workflow, no compliance regime.

Either path is wrong for v1. (a) is theater; (b) is premature. Skip the layer cleanly and spend the budget on log redaction, which defends the actual high-frequency leak vector — most personal-data exposure in real systems is accidental logging, not DB exfiltration.

**The unfixable gap that exists either way: embedding inversion.** A `chunks.embedding` vector + the embedding model + published inversion techniques can reconstruct surprisingly accurate text. Encrypting the vector is not an option (kills pgvector indexing). The only defense is "trust your embedding provider" — contractual, not cryptographic. This is true with or without column-level encryption, so it does not tip the decision.

**What the posture defends against:**

| Threat | Posture defends? |
| --- | --- |
| Stolen Railway disk image / lost backup file | Vendor crypto ✅ |
| Accidental `console.log` of email body in a worker | Pino redactor ✅ |
| Error stack trace with chunk text reaches Sentry | Sentry scrubber ✅ |
| Fat `documents.raw` JSON copied into a debug dump | Column doesn't exist ✅ |
| App-server RCE | No (true for any server-side scheme) |
| Vendor employee with raw DB access | No (would need (b) above) |
| Voyage / Anthropic / Perplexity reading content we send them | No (contractual) |
| Embedding inversion from leaked vector | No (architectural) |

**Alternatives.**

- App-layer AES-256-GCM with key in Railway env (rejected — same blast radius as the DB; ceremonial).
- Key outside Railway via 1Password CLI / external secret store (rejected for v1 — real protection but premature for the actual threat surface).
- Per-user keys / envelope encryption with per-record DEKs (rejected — single user, single owner; ratio of complexity to delta is absurd).
- Searchable symmetric encryption / encrypted vector spaces (rejected — academic, fragile, and the only real win would be defending embedding inversion, which it doesn't).

**Triggers to revisit this ADR.** Any of these flips the math toward path (b) above:

- A contractor or second user lands on the system.
- A real backup-export workflow exists (regular `.sql` dumps moved off Railway, sent to anyone, or archived to a separate vendor).
- An analytics pipeline or read-replica gets DB-read access scoped narrower than the app's full secret set.
- A compliance regime (SOC2, HIPAA, GDPR contracts) becomes a real requirement.

Adding the encryption layer later is a straightforward forward migration — new `*_iv` / `*_kid` columns, a backfill job that reads plaintext and writes ciphertext, flip the read/write paths. The schema doesn't bake in irreversibility.

**Implementation shape.**

- `packages/api/src/lib/logging.ts` — Pino instance with `redact.paths` covering known sensitive field paths (`*.content`, `*.extracted_text`, `*.body`, `documents.raw`, `memory_facts.value`, `attachment_pages.*`). Redaction renders as `[REDACTED]` so the structural shape of logs is preserved for debugging.
- Sentry config (`apps/server/src/instrument.ts`) — `beforeSend` and `beforeBreadcrumb` hooks strip the same paths from event payloads. Errors keep their stack frames; only field values disappear.
- Drizzle migration — `documents` drops the `raw` column. Existing rows lose `raw`; we never read it on the hot path.
- Gmail ingest (`packages/integrations/src/google/gmail.ts`) — stops persisting the MIME tree. Extraction stays in-memory during the ingest job; `documents.metadata` keeps the small derived fields (sender, headers we actually use).
- Same redaction list lives in one shared const (`SENSITIVE_LOG_PATHS` in `@alfred/contracts`) so Pino, Sentry, and any future logger pull from one source.

**Caveat that goes in the codebase, not just here.** A short comment on `chunks.embedding` in `packages/db/src/schema/documents.ts` should call out: "Plaintext by design — encrypting kills pgvector. Embedding-inversion attacks can leak content from the vector alone; see ADR-0038." Future readers shouldn't discover the gap by accident.

---

## ADR-0039 — Email attachment ingestion: dedicated `attachments` family, page-bounded typed chunks, separate extraction queue

**Decision.** Attachments on ingested emails become first-class entities with their own ingestion path, distinct from the existing `documents`/`chunks` text flow. Three pieces:

1. **Schema family** — new `attachments` and `attachment_pages` tables; `chunks` gains `attachment_page_id` (xor with `document_id`) plus segment-typing columns.
2. **Extraction stack** — Anthropic Claude (Haiku 4.5 default) takes PDF/image input, returns a prompt-shaped typed-segment JSON. Same call shape for standalone images. Metered as `attribution.kind = 'doc_extraction'`.
3. **Dedicated `doc-extraction-runs` BullMQ queue** — isolated from `ingestion-runs` so Anthropic latency and dollar-cost don't bleed into Gmail polling.

**Why this is its own ADR.** ADR-0010 chose one `documents` + `chunks` schema "source-tagged" and explicitly punted attachments. ADR-0021 (embedding) and ADR-0037 (realtime ingestion) likewise assumed flat text bodies. Attachments break three of those assumptions at once — they have page structure, they carry typed elements (tables, figures), and their extraction has a per-call dollar cost. Trying to retrofit `documents` would either (a) add nullable page-shaped columns that don't apply to emails, or (b) hide the typing inside `metadata` jsonb where retrieval can't filter on it. A sibling table is the honest shape.

**Schema (sketch — full DDL lands in the migration):**

```
attachments
  id, user_id, parent_document_id (→ documents.id),
  source ('gmail'), source_part_id, mime_type, filename, byte_size, sha256,
  page_count nullable,
  binary_uri (Railway bucket key — gmail attachments live forever in our bucket),
  extraction_status ('pending' | 'extracting' | 'extracted' | 'failed' | 'skipped'),
  extraction_model, extracted_at, last_error,
  skipped_reason ('mime_unsupported' | 'size_exceeded' | null),
  truncated_at_page nullable,
  lifecycle_dates

attachment_pages
  id, attachment_id (→ attachments.id, cascade),
  page_number,
  extracted_text (concatenated page text; plaintext at rest per ADR-0038),
  asset_inventory jsonb {
    tableCount, figureCount, footnoteCount,
    hasImages, hasLinks, headings: string[]
  },
  layout_hint nullable,
  unique(attachment_id, page_number)

chunks  (gains columns; existing rows unaffected)
  attachment_page_id nullable (→ attachment_pages.id, cascade),
  CHECK ((document_id IS NULL) <> (attachment_page_id IS NULL)),  -- xor
  kind ('text' | 'table' | 'figure_caption' | 'heading' | 'footnote' | 'list'),
  parent_section text nullable,
  bbox jsonb nullable
```

`chunks` stays the single source of truth for embedded vectors — retrieval queries one table and decides at render time whether the citation points back to a `documents` row or an `attachment_pages` row. No polymorphic join, no UNION across tables.

**Chunking semantics (extends `packages/ingestion/src/chunker.ts`):**

- **Page is the citation/grouping anchor.** Chunks never cross page boundaries.
- **Typed segments within a page.** Each chunk's `kind` matches an extractor-emitted segment type.
- **Tables never split mid-row.** A table is its own chunk regardless of size; if it exceeds `maxTokens`, it lands with `metadata.truncated = true` and the boss agent sees a flag rather than a corrupted table.
- **Headings cascade.** A `heading` chunk becomes a standalone chunk AND populates `parent_section` on every subsequent non-heading chunk on the same page. A retrieved chunk knows "I'm under §3.2 Termination" without re-reading neighbors.
- **No cross-page overlap at v1.** Ideas-that-straddle-a-page-break are split. Same trade the email chunker has at paragraph boundaries; revisit if observed retrieval misses are real.

**Extraction stack (Claude with PDF/image input):**

- Default: **Haiku 4.5** at ~$0.005–0.02/page. PDF goes in via `document` content type; standalone images via `image` (single page).
- **Sonnet escalation rule:** if a page's `assetInventory.figureCount > 0` AND any figure has no caption returned by Haiku, re-extract that page only with Sonnet. Bounded cost increase, sharply better figure descriptions when they matter.
- **Schema control.** The system prompt specifies the exact JSON shape — `{ pages: [{ pageNumber, segments: [{ kind, text, bbox?, parentSection? }], assetInventory }] }`. No vendor schema-translation layer.
- **Vendor alignment.** Anthropic is already a paid dependency; no new SDK, contract, or credential surface.

**Dedicated queue: `doc-extraction-runs`.**

Co-mingling extraction with `ingestion-runs` would let one Anthropic outage backlog Gmail polling, and a burst of attachments would starve `gmail.poll_recent` of worker slots. The queues have different latency, cost, retry, and concurrency profiles:

| Property | `ingestion-runs` | `doc-extraction-runs` |
|---|---|---|
| Per-job latency | sub-second | multi-second per page |
| Per-job dollar cost | ~$0 | real money |
| Bottleneck | Gmail rate limits | Anthropic rate limits |
| Concurrency default | 2 | 5 |
| Retry shape | 5 attempts, 5s backoff | 3 attempts, 30s backoff |

Jobs on the new queue:

- `attachment.extract { attachmentId }` — primary unit. Pulls binary from the Railway bucket, runs the Claude call, persists pages + chunks, flips `extraction_status`.
- `doc-extraction.sweep` — hourly repeatable. Picks up `attachments` rows stuck in `pending` for > 1hr or `failed` with < 3 attempts. Mirrors `gmail.embed_sweep`'s shape.

Terminal failure flips `extraction_status='failed'` with `last_error` populated; no separate dead-letter table. The row IS the dead letter, queryable from the UI.

**Realtime pipeline after this ADR:**

```
gmail.poll_recent (existing — ingestion-runs queue)
  → persistMessage
      ├── inserts documents row
      └── inserts attachments rows for each MIME part with attachmentId
          (subject to MIME allowlist + size cap — see gates below)
  → fan in parallel:
      ├── enqueueTriageRuns           (existing — body only, no attachment dep)
      ├── embedRealtimeInserts        (existing — best-effort)
      └── enqueueAttachmentExtracts   (NEW — pushes attachment.extract jobs
                                       onto doc-extraction-runs)
```

Triage stays on the body. Per Q9 of the design: the six triage categories are body-shape signals; coupling triage to extraction latency would walk back ADR-0037's realtime gains for marginal accuracy. Edge case accepted: "see attached" emails with empty bodies may mis-classify as `fyi` when the attachment makes them `action_needed`. The user can re-label; the next message in the thread gets a fresh classification.

**Cost gates (four, in pipeline order):**

1. **MIME allowlist at enqueue.** `application/pdf`, `image/png`, `image/jpeg`, `image/heic`, `image/webp`. Else → row created with `extraction_status='skipped'`, `skipped_reason='mime_unsupported'`. Row exists so the UI can show "we have a `.zip` here we didn't process" rather than the attachment invisibly vanishing.
2. **20 MB size cap at enqueue.** Else → `skipped_reason='size_exceeded'`. Real receipts/contracts/passport scans are < 5 MB; > 20 MB is almost always video, scans at absurd DPI, or someone's portfolio.
3. **50-page cap at extraction time.** Read PDF header (cheap, no Claude call) for `pageCount`; if > 50, extract pages 1–50 and set `attachments.truncated_at_page = 50`. First 50 pages are almost always the substantive content; back half is appendices and signature blocks. A future tool can request a deeper extract on demand.
4. **$5/day per-user soft cap.** Worker `beforeProcess` queries `SUM(cost_usd) WHERE kind='doc_extraction' AND user_id = ? AND created_at::date = current_date`. If over, `job.moveToDelayed(nextMidnight())`. Deferred, not lost. Env-configurable as `ALFRED_DOC_EXTRACTION_DAILY_BUDGET_USD`; promotes to `user_action_policies` only when a second user appears.

Explicitly rejected: filename heuristics (`/terms|legal|tos/i` → skip) — too brittle; `Terms_of_Sale_for_HouseClosing.pdf` is exactly the kind of doc to extract. Per-MIME budget splits — premature. Adaptive throttling on Anthropic rate limits — BullMQ concurrency 5 + 30s retry backoff handles it.

**Lifecycle (per Q7 of the design):**

- **Binaries land in the Railway bucket on ingest** and stay forever. ADR-0038 dropped `documents.raw` because Gmail is durable; attachments invert that — Gmail's attachment retention is bounded by message lifetime, so to keep "show me my passport" working after inbox-zero, we hold the bytes ourselves.
- **Email deletion in Gmail does not cascade.** Inbox-cleanup ≠ memory revocation. A separate explicit "forget this" UI lands later for real deletion intent.
- **Re-extraction with a future better model is possible** for every attachment because binaries are durable. The extraction call is the only variable.

**Retrieval interaction.**

A `chunks` row from an attachment renders citations as "page N of {filename}" by joining `chunks → attachment_pages → attachments`. The `kind` column lets the boss agent answer "what tables are in this PDF" without re-reading the document — `WHERE attachment_id = ? AND kind = 'table'` over `chunks`. The `asset_inventory` jsonb on `attachment_pages` supports the higher-level query "which page has the financial breakdown" without joining chunks at all.

**Trade-offs being accepted:**

- **Vendor cost on the realtime path.** Every email with a PDF kicks off a paid Claude call. Four-gate shield bounds the worst case at ~$5/day; observed steady-state should be < $0.50/day at single-user volume.
- **Two-table read on every attachment citation.** Retrieval pays one extra join (`chunks → attachment_pages → attachments`) compared to email chunks. Negligible at our index size.
- **No category filter** (deferred per the 2026-05-22 grilling, see Open/deferred). Promo/social/forum emails go through the full pipeline including extraction. Gates 2–4 bound the cost; revisit if observed extraction spend on those categories is materially non-zero.
- **Cross-page idea splits.** No overlap across page boundaries. Same trade as the email chunker at paragraph boundaries; not solved at v1.
- **Claude vendor exposure on attachment content.** Same posture as embeddings via Voyage and triage via the cheap-tier LLM — contractual, not cryptographic, per ADR-0038.

**Alternatives.**

- **Single `documents` table with nullable page-shape columns** (rejected — pollutes the email-only happy path; typing hidden in `metadata` jsonb where retrieval can't filter).
- **Polymorphic `chunks.owner_kind + owner_id`** (rejected — every read path acquires a coalesce; no real win at single-user scale over the xor approach).
- **Inline attachment text appended to `documents.content`** (rejected — burns the page boundary at ingest, kills citation precision, churns `content_hash` on re-extraction).
- **Mistral OCR / LlamaParse / Reducto for extraction** (rejected — strong vendors but adds a new contract/SDK/credential surface for marginal cost savings vs the existing Anthropic relationship; revisit if Anthropic extraction quality proves insufficient).
- **Native pdf-parse + per-image vision** (rejected — collapses tables to wall-of-text; quality on the use cases we care about is bad).
- **Cascade-delete attachments on Gmail message deletion** (rejected — inbox hygiene ≠ memory revocation; "forget this" is a distinct explicit UX).
- **MIME extension to include `.docx`** (deferred — PDF covers 95% of business docs; add when business-doc use cases prove real).

**Triggers to revisit.**

- **Multi-user.** $5/day env-var budget moves to a per-user column in `user_action_policies`.
- **Sustained extraction spend on promo/social/forum mail.** Promotes the deferred category filter from Open/deferred into a real ADR.
- **Anthropic extraction quality complaints.** Comparative eval against Mistral OCR / LlamaParse; the extraction module is one file, swapping vendors is bounded.
- **A real "summarize this PDF" feature for > 50-page docs.** Drops the 50-page cap or makes it user-overridable per attachment.

**Implementation order (when this milestone opens):**

1. Drizzle migration — new tables + `chunks` column additions + xor CHECK constraint.
2. Railway bucket provisioned; binary upload helper in `packages/integrations/src/google/gmail.ts` (re-uses existing OAuth client).
3. Extraction module in `packages/ingestion/src/extract-document.ts` — Claude call with the typed-segment prompt, returns the canonical JSON; handles Sonnet escalation on caption-less figures.
4. New BullMQ queue in `packages/api/src/modules/integrations/queue.ts` (or extract into its own module if `queue.ts` is getting fat).
5. `enqueueAttachmentExtracts` helper called from the existing realtime path next to `enqueueTriageRuns` + `embedRealtimeInserts`.
6. Four gates wired in (MIME + size at enqueue; page-count + budget at worker).
7. Smoke script: `pnpm --filter server tsx --env-file=.env src/scripts/smoke-attachments.ts` against a real Gmail with a known PDF.

---

## ADR-0040 — m13 Phase 4 brief-only execution: ping-pong steps, sentinel workflow, dedicated transcript column, system-tool autonomy override

**Decision.** Phase 4 of m13 replaces the current registry-miss behavior for user-authored workflows with a real `AlfredAgent`-driven loop. Eight coordinated micro-decisions compose this:

1. **Two named executor steps that ping-pong.** `boss-turn` runs exactly one `AlfredAgent.turn()`; `dispatch-tools` routes each returned tool call through `dispatchToolCall` (ADR-0034) and appends results to the transcript. Each cycle ends with `next: 'boss-turn'`, `done`, or `interrupt`.
2. **User-authored slug resolution via a single sentinel `Workflow<S>`.** `requireWorkflow(slug)` stays strict for code-registered workflow lookup. `resolveWorkflowForRun({ userId, workflowSlug })` returns the registry hit when one exists; otherwise it checks `workflows (userId, slug)`. A missing row OR `is_builtin=true` throws (covers deleted-builtin deploy bugs); `is_builtin=false` routes through the shared `userAuthoredBriefWorkflow` sentinel. `createRun` must still insert the requested slug into `agent_runs.workflow_slug`, not the sentinel slug, so history joins back to the user-authored row.
3. **Dedicated `agent_runs.transcript jsonb` column** typed `AgentTranscriptMessage[]` from `@alfred/contracts`. `Workflow.initialTranscript(input)` seeds it at run creation; the executor leases it with the run row and `StepResult` can carry an optional replacement transcript that commits atomically with the step result. `BriefRunState.inFlightTailStart` records the compaction boundary for the current turn. The Phase 7 compactor rewrites the same column in place. `@alfred/api` casts/converts the stored structural type to AI SDK `ModelMessage[]` only at the `AlfredAgent.turn()` boundary, keeping `@alfred/db` free of an `ai` dependency.
4. **Strict `@`-mention seed.** `state.activeIntegrations` at run start = `INTEGRATION_SLUGS ∩ parsed @-slugs in brief ∩ workflows.allowed_integrations`. An empty seed is legitimate; the boss grows the set via `system.load_integration`. No fallback to "all connected integrations." (Refines ADR-0026; see amendment there.)
5. **System-tool dispatch contract.** `system.*` tools register via the same `liveTool` factory. The dispatcher applies a structural `if (integration === 'system') policyMode = 'autonomy'` short-circuit before `resolvePolicyMode`. State-changing system tools (`load_integration`, future `spawn_sub_agent`) take the full audit-row path; chatty no-op-side-effect tools (`read_scratch`, `write_scratch`, `promote` in Phase 6c) get a fast-path that skips staging. **Tool `execute` is pure** — it validates against context supplied by the step (for `load_integration`, the workflow allowlist) and returns a structured allowed/not-allowed result. Mutation of `agent_runs.state` happens in the `dispatch-tools` step body via a small switch on `toolName`, never via tool internals reaching into `db()`.
6. **Stable system prompt; brief in the first user message.** The cache-stable `system` block holds a user-stable preamble (Anthropic's 10-section template: role / tone / rules / examples / think / format). The workflow brief is the first `user` message in the transcript. `activeIntegrations` is reflected only via the per-turn `tools` resolver — never narrated in `system` — so `load_integration` calls don't break the system cache.
7. **`description: string` required on `RegisteredTool`.** No default fallback; missing description breaks the build. Backfill the four existing tools (`gmail.search`, `gmail.send_draft`, `calendar.list_events`, `calendar.create_event`) and add one for `system.load_integration`.
8. **Smoke via auto-approve.** `smoke-brief-execution.ts` exercises the loop with `default_mode='gated'` intact — the smoke approves any pending `action_stagings` via direct DB write + `signalRun()` mid-loop, covering both the autonomous and gated/resume paths in one run.

**Why each piece.**

- **Ping-pong over a single self-looping step.** One `boss-turn` row maps 1:1 to one `api_call_log` row (ADR-0015 invariant). `interrupt` for HIL falls out of `dispatch-tools` when the dispatcher returns `kind: 'staged'`. Crash-resume is sharper: a dispatch failure restarts only the dispatch loop, not a fresh LLM call. Phase 7's `compact-transcript` step slots in as a third named step without restructuring. The cost — twice as many `agent_steps` rows per turn — is irrelevant at single-user scale and makes the History tab more legible (the alternation is the agentic shape, narrated honestly).

- **Single sentinel workflow + existence check on miss.** User-authored brief-only workflows share their entire execution shape; only `agent_runs.workflow_slug` distinguishes runs. Registering one code-side `Workflow<S>` is the only sane approach that scales to N user workflows per user. Alternatives — registering per-slug at boot (requires restart per user create), lazy-registering per slug (per-slug state for no gain), making `requireWorkflow` async (ripples through every strict lookup) — all fail one or more of: zero-restart UX, no extra state, executor signature clarity. The `is_builtin=true` branch of the existence check stops a deleted-builtin deploy from silently masquerading as a user workflow. Preserving the requested slug in the run row is load-bearing; otherwise every user-authored run would join to `__user-authored-brief__` instead of the workflow the user edited.

- **`agent_runs.transcript` as a sibling jsonb.** Folding the transcript into `agent_runs.state` pollutes a deliberately-small structured shape and forces every step (including non-LLM ones like Phase 7's `compact-transcript`) to drag the full transcript through `ctx.state`. A child message table is premature optimization at single-user scale and fights Phase 7's compactor (which rewrites the view). Redis-primary mirrors ADR-0036 but solves a problem we don't have: transcript writes are one-per-turn, not concurrent. The executor needs first-class transcript plumbing so step bodies do not fall back to side-channel DB writes or `state.transcript`.

- **Strict-seed `@`-mentions.** Permissive seeding (all connected integrations) makes the same brief produce a different toolset on different days and breaks Anthropic's tool-definition cache stability across runs. Strict seeding makes authoring intent explicit, costs at most one extra round-trip per integration the boss needs to load mid-run, and is relaxable later without a migration. ADR-0026 amended above.

- **Structural autonomy for `system.*`.** Seeding `user_action_policies.integration_rules.system = { mode: 'autonomy' }` at signup (Phase 1c) is the data answer. The belt-and-suspenders dispatcher short-circuit means the invariant *"`system.*` is structurally non-gateable"* survives a future user toggle, a missing default row, a botched migration, or a policy-editor bug. Six lines in `dispatchToolCall`; cost-free defense in depth.

- **Pure `execute`; step body interprets state mutations.** The executor reads `state` at step start (`executor.ts:96`) and writes it at step commit (`executor.ts:288`). Side-channel writes during dispatch race the commit. Returning a structured result and applying it in the step body keeps all state writes in one transactional path — the executor's contract stays uniform, and the system-tool effect is *one* known place to read for "what does load_integration actually do" rather than spread across tool internals, dispatcher branches, and runtime context.

- **System prompt cache stability.** ADR-0026's strict-pinning catches accidental system drift across turns within a single `AlfredAgent` instance. The executor instantiates a fresh `AlfredAgent` per step, so the protection is per-step only — useless across the run. The actual concern is byte-identical `system` across turns in a run (Anthropic prompt cache) and across runs of all user-authored briefs (cross-run prefix hits). Putting the brief in the first user message — not `system` — maximizes the shared prefix per user. Tool definitions flow through the SDK's `tools` field, so `load_integration` growing the active set never touches the system block.

- **Required tool description.** Without it, the model picks tools by name guess. Optional-with-default would silently hide a registration bug; required at the type level breaks the build.

- **Auto-approve smoke.** Covers both the autonomous and the gated/resume paths in one run, mirrors how the real user will use Alfred (default-gated), and produces a reusable "approve N pending stagings" helper for Phase 5's UI tests.

**Step shape (pseudocode).**

```
boss-turn:
  transcript = ctx.transcript
  agent = new AlfredAgent({
    system: PREAMBLE,                                          // stable per user
    tools: () => resolveSdkTools(state.activeIntegrations),    // re-read per turn
    model: getBossModel(),
  })
  result = await agent.turn({ ctx, transcript })
  state.turnCount += 1
  if state.turnCount > TURN_CAP_MAX → throw new Error('turn_limit_exceeded')

  switch (result.kind):
    'final'      →
      state.inFlightTailStart = transcript.length
      transcript = [...transcript, ...result.raw.response.messages]
      { kind: 'done', state, transcript, output: { text: result.text } }
    'tool-calls' →
      state.inFlightTailStart = transcript.length
      state.pendingToolCalls = result.toolCalls
      transcript = [...transcript, ...result.raw.response.messages]   // assistant message + toolCalls
      { kind: 'next', state, transcript, nextStep: 'dispatch-tools' }
    'stopped'    →
      state.inFlightTailStart = transcript.length
      transcript = [...transcript, ...result.raw.response.messages]
      { kind: 'done', state, transcript, output: { stoppedReason: result.reason } }

dispatch-tools:
  transcript = ctx.transcript
  while state.pendingToolCalls.length > 0:
    call = state.pendingToolCalls[0]
    r = await dispatchToolCall({
      runId, stepId: 'dispatch-tools', toolCallId: call.id,
      toolName: call.toolName, input: call.input, userId,
    })

    if r.kind === 'staged':
      // Park. Remaining tool calls re-dispatch on resume — idempotent via
      // (run_id, tool_call_id) unique on action_stagings.
      { kind: 'interrupt', state, transcript, wake: r.wake }

    // System-tool effects: pure execute returns a structured result;
    // the step body applies the effect to in-memory state, executor
    // commits it atomically with the step row.
    if call.toolName === 'system.load_integration' && r.kind === 'executed' && r.toolResult.ok:
      state.activeIntegrations = unique([...state.activeIntegrations, r.toolResult.slug])
    // future: system.spawn_sub_agent, etc.

    transcript = [...transcript, toolResultMessage(call.id, r)]
    state.pendingToolCalls = state.pendingToolCalls.slice(1)

  state.pendingToolCalls = []
  { kind: 'next', state, transcript, nextStep: 'boss-turn' }
```

**Sentinel workflow.**

```ts
// packages/api/src/modules/agent/workflows/user-authored-brief.ts
export const userAuthoredBriefWorkflow: Workflow<BriefRunState> = {
  slug: '__user-authored-brief__',     // never collides — never registered into the registry
  name: 'User-authored brief',
  trigger: { kind: 'manual' },
  initialStep: 'boss-turn',
  initialState({ brief, metadata }) {
    if (!brief) throw new Error('user-authored brief workflow requires a brief');
    const allowed = (metadata?.allowedIntegrations as readonly string[] | undefined) ?? [];
    return {
      activeIntegrations: parseIntegrationMentions(brief, allowed),
      allowedIntegrations: allowed,     // empty = unrestricted
      pendingToolCalls: [],
      inFlightTailStart: 0,
      turnCount: 0,
    };
  },
  initialTranscript({ brief }) {
    if (!brief) throw new Error('user-authored brief workflow requires a brief');
    return [{ role: 'user', content: brief }];
  },
  steps: { 'boss-turn': bossTurnStep, 'dispatch-tools': dispatchToolsStep },
};

// service.ts: `resolveWorkflowForRun` falls back here on registry miss
// only after an existence check on (userId, slug) + is_builtin=false guard.
// Typos and deleted builtins fail loud.
```

`allowedIntegrations` is threaded through `createRun.metadata.allowedIntegrations` at the call site (either `workflows.tick` or `/api/agent/runs`) so the workflow row's allowlist reaches `initialState` without a second DB read. `dispatch-tools` also passes this allowlist into `ToolExecuteContext` for `system.load_integration`; the tool returns `{ ok: false, status: 'not_allowed', slug }` instead of mutating or throwing when the slug is outside the cap.

**Transcript column.**

```ts
// packages/db/src/schema/agent.ts — agentRuns table addition
transcript: jsonb('transcript')
  .$type<AgentTranscriptMessage[]>()
  .notNull()
  .default(sql`'[]'::jsonb`),
```

One migration via `pnpm db:generate` → `db:migrate`. Default `'[]'`; no backfill (existing builtin runs don't use it). `AgentTranscriptMessage` lives in `@alfred/contracts` as a zero-dep structural alias for the subset of AI SDK messages Alfred persists; no `ai` import belongs in `@alfred/db`. The executor must load/commit this column explicitly; `agent_runs.state` remains the compact structured control state (`activeIntegrations`, `allowedIntegrations`, `pendingToolCalls`, `inFlightTailStart`, `turnCount`, etc.).

**`@`-mention parser.**

```ts
// packages/contracts/src/mentions.ts (zero-dep, importable from db + api + web)
const MENTION_RE = /(?:^|[^a-z0-9_-])@([a-z][a-z0-9_]*)/gi;

export function parseIntegrationMentions(
  brief: string,
  allowedIntegrations: readonly string[],
): IntegrationSlug[] {
  const allowed = allowedIntegrations.length > 0
    ? new Set<string>(allowedIntegrations)
    : new Set<string>(INTEGRATION_SLUGS);              // empty = unrestricted (cap-side)
  const seen = new Set<IntegrationSlug>();
  for (const m of brief.matchAll(MENTION_RE)) {
    const slug = m[1]?.toLowerCase() ?? '';
    if (!INTEGRATION_SLUGS.includes(slug as IntegrationSlug)) continue;
    if (slug === 'system') continue;                   // never user-seedable
    if (!allowed.has(slug)) continue;
    seen.add(slug as IntegrationSlug);
  }
  return [...seen];
}
```

`@skill:slug` is left alone — skill mounting lands later. Unknown slugs are ignored and never throw.

**Dispatcher autonomy override.**

```ts
// dispatch/index.ts, inside dispatchToolCall, before resolvePolicyMode
const integration: IntegrationSlug = integrationFromToolName(args.toolName);
const policyMode: PolicyMode =
  integration === 'system'
    ? 'autonomy'                                      // structural; bypass user_action_policies
    : await resolvePolicyMode(args.userId, args.toolName);
```

Audit row still lands for `system.load_integration` (and Phase 6's `system.spawn_sub_agent`); `requires_approval` is false. Scratchpad tools in Phase 6c will branch above this point into a fast-path that skips staging.

**Tool resolver.**

`AlfredAgent.tools` expects an SDK `ToolSet`; our registry holds `RegisteredTool`. The boss step builds the per-turn SDK toolset:

```ts
function resolveSdkTools(activeIntegrations: IntegrationSlug[]): ToolSet {
  const out: Record<ToolName, Tool> = {};
  for (const slug of [...activeIntegrations, 'system']) {       // system tools always present
    for (const t of listToolsForIntegration(slug)) {
      out[t.name] = tool({
        description: t.description,
        inputSchema: t.inputSchema,
        // execute intentionally omitted — AlfredAgent strips it anyway; dispatcher executes.
      });
    }
  }
  return out as ToolSet;
}
```

**System prompt skeleton.**

The preamble lives beside the sentinel workflow in `packages/api/src/modules/agent/workflows/user-authored-brief.ts` (factor it out once a second boss workflow needs it) and follows Anthropic's 10-section template (sections 1, 2, 4, 5, 8, 9 in the cache-stable system block; 3, 6, 7 flow through the message stream; 10 unused):

```
1. Task context  — "You are Alfred, the user's personal assistant agent."
2. Tone          — concise; brief reasoning before tool calls.
4. Rules         — tool families (integration tools, system tools);
                   system.load_integration to grow the toolset;
                   rejection contract (`status: 'rejected_by_user'` → don't retry identical).
5. Examples      — one short tool-call exchange + one final-summary exchange.
8. Think         — "briefly reason about your next action before calling a tool."
9. Format        — "End the run with a single user-facing summary message (no tool calls)."
```

Section 7 (immediate request) = the brief, as the first user message. Section 6 (history) = turn-by-turn `transcript`.

**Safety.**

- **Mixed staged + autonomous in one turn.** The first `dispatchToolCall` returning `kind: 'staged'` short-circuits `dispatch-tools` with `interrupt`. Successfully dispatched calls are consumed from `state.pendingToolCalls` before the interrupt commits, so resume does not append duplicate tool-result messages. The staged call and any later calls remain in `pendingToolCalls`; the `(run_id, tool_call_id)` unique index on `action_stagings` makes the staged call resume against the same row after approval.
- **Turn cap.** `state.turnCount` increments in `boss-turn`; exceeding `30` fails the run with `error.message = 'turn_limit_exceeded'`. Belt-and-suspenders against runaway loops; configurable later if needed.
- **`stopped` finish reasons.** `length` and `content-filter` map to `done` with `output.stoppedReason`; `error` and `other` map to `failed`. The History tab surfaces the reason verbatim.

**Smoke target.**

`packages/api/src/modules/agent/smoke-brief-execution.ts`:

1. Insert a `workflows` row with brief: `"@gmail — Read my most recent inbox email and summarize it in one sentence. Then tell me what's on my calendar tomorrow morning."`, `allowed_integrations: ['gmail', 'calendar']`, `is_builtin: false`, `status: 'active'`.
2. `createRun({ workflowSlug, userId, brief, metadata: { allowedIntegrations }, trigger: { kind: 'manual' } })` → `enqueueRun`.
3. Background poll: while the run isn't terminal, scan `action_stagings WHERE run_id = ? AND status = 'pending'`. For each: `UPDATE … SET status='approved', decided_at=now(), row_version=row_version+1`, then `signalRun({ runId, match: { kind: 'hil', approvalId: stagingId } })`.
4. Wait until `agent_runs.status = 'completed'` or timeout (60s).
5. Assertions:
   - `agent_runs.status = 'completed'`.
   - ≥ 2 `boss-turn` + ≥ 2 `dispatch-tools` step rows.
   - `action_stagings` has rows for `system.load_integration`, `gmail.*`, and `calendar.*`, all `status='executed'`.
   - `state.activeIntegrations` (read from `agent_runs.state`) is `{ gmail, calendar }` as a set.
   - `api_call_log` row count equals `boss-turn` step row count (ADR-0015 invariant).
   - `agent_runs.output.text` non-empty.

**Alternatives.**

- (a) **Single self-looping `agent-loop` step** instead of ping-pong. Rejected — multiple turns per step row violates ADR-0015's per-turn metering invariant; HIL interrupt mid-loop requires splitting state into "before/after dispatch," which is exactly what the second step makes explicit.
- (b) **Lazy-register a `Workflow` per user slug.** Rejected — adds per-slug registry state for no benefit; the sentinel handles everything identically.
- (c) **Transcript on `agent_runs.state.transcript`.** Rejected — state shape pollution; every step drags the full transcript through `ctx.state` regardless of whether it cares.
- (d) **Permissive `@`-mention seed (all connected integrations when no mentions).** Rejected — non-determinism across runs of the same brief, tool-definition cache thrashing across runs, surprising boss behavior. Strict + `load_integration` is more explicit and easy to relax later.
- (e) **`mutateRunState` callback on `ToolExecuteContext`.** Rejected — hidden state-write surface; couples tool internals to executor mechanics.
- (f) **`DispatchResult.stateDelta` field.** Rejected — moves system-tool knowledge into the dispatcher rather than the step body; both layers stay dumber if the step body owns the effect.
- (g) **Brief in the `system` block.** Rejected — smaller shared prefix across the user's workflows. Putting the brief in the first user message lets the system prompt be byte-identical across every brief-only run for one user, maximizing Anthropic's prefix cache hits.

**Open.**

- Whether `ai-retry` (warden's `createRetryable` pattern) wraps `getBossModel()` / `getSubAgentModel()` / `getCheapModel()` exports. Not Phase 4 — separate `@alfred/ai` refactor that affects every LLM caller.
- Phase 7 introduces the `compact-transcript` step after `dispatch-tools` when the threshold trips; the prompt and tail-selection details still get a dedicated Phase 7 pass.
- Turn cap default (30) is a guess; revisit when real runs accumulate.
- `system.spawn_sub_agent` is registered in `@alfred/contracts` but Phase 6's responsibility to implement and route through `dispatch-tools`'s step-body interpreter.
- Whether the workflow CRUD layer should reject user slugs starting with `__` to keep the sentinel namespace pristine. Defensive niceness; not blocking.

---

## ADR-0041 — Daily briefing v2: cross-source LLM compose, split surface, `briefings` entity

**Decision.** The daily briefing is rebuilt around six coordinated micro-decisions, superseding the m10 deterministic-render path and widening the inbox-only fidelity bound from ADR-0033:

1. **Cross-source gather.** Five contributions feed each day's briefing: email triage rollup, Google Calendar (today's events), integration activity (GitHub first planned direct producer; other providers later only when their integrations exist), weather (Open-Meteo, location resolved from prefs/memory), day-of-week + holidays. Each source exposes `collectBriefingContribution(userId, date) → BriefingContribution` — same extensibility pattern as ADR-0011's cold-start signals. Future operational providers bolt on as activity producers without adding a new top-level briefing source.
2. **Single LLM compose call (boss-tier).** `gather → compose → send` stays the workflow shape, but `compose` becomes one `meteredGenerateText` call with `getBossModel()` and `output: zod(briefingComposerSchema)`. Cheap-tier produces flat tone-deaf prose for the warmth this surface needs; the per-day cost (~$0.02) is the right place to spend.
3. **Two artifacts from one composer call.** `breakingSummary` (4-6 lines of markdown) is the email body source; `fullBriefing` (`{ headline, sections: { source, label, body, why?, references? }[], sourcePanels?, auditSummary? }`) is the in-app surface. Single call emits both prose surfaces — they cannot drift in tone or facts because they share a generation. The full page exposes source-backed inclusion rationale, not raw model reasoning. Raw `gather` stays stored for audit/replay, and deterministic code builds `sourcePanels` from gather + resolved references after compose so the UI does not branch on every contributor's raw shape.
4. **Reference resolution via `[[<kind>:<id>]]` placeholders.** Composer prose names entities by opaque token, not URL. A per-surface resolver expands against the gather: email HTML gets bold + service icon + anchor; in-app gets a typed `<EntityChip>`; plain-text fallback uses the entity's label. The LLM never sees or generates a URL — prevents hallucinated links. Kinds at v1: `activity | meeting | email` (closed enum in `@alfred/contracts`). Provider-specific operational details live in `IntegrationActivityItem.providerKind`, not in the reference-kind enum.
5. **New `briefings` entity, one row per `(user_id, briefing_date)`, idempotent.** Canonical record of the day. Status-machine lifecycle. Replicache-synced read-only with a 30-day pull window. `briefing_date` is a PG `date` (string mode, no JS Date noise); `timezone` is branded `IanaTimezone` text validated against `Intl.supportedValuesOf('timeZone')` at the API boundary. Both columns are load-bearing — see below.
6. **New metering attribution kind: `briefing`.** Const-narrowed in `@alfred/contracts.AttributionKind`. Cost rollups bucket the daily briefing apart from agent runs, triage, web search, doc extraction.

**Trigger model unchanged.** Hourly `briefing.tick` continues to honor `user_preferences.briefing.delivery_hour`. Per-user scheduled jobs were considered and rejected — at single-user scale the tick's index lookup is free, and a second BullMQ scheduler buys nothing the unified `workflows.tick` (ADR-0027) hasn't already justified.

**Schema sketch.**

```ts
// packages/db/src/schema/briefings.ts
briefings (
  id            text PK,                          -- createId('brf')
  user_id       text FK -> users,
  briefing_date date NOT NULL,                    -- 'YYYY-MM-DD' in user tz (mode: 'string')
  timezone      text NOT NULL,                    -- $type<IanaTimezone>()
  status        text NOT NULL,                    -- 'pending' | 'gathering' | 'composing' | 'sent' | 'failed'

  gather           jsonb NOT NULL,                -- $type<BriefingGather>()
  breaking_summary text NOT NULL DEFAULT '',
  full_briefing    jsonb NOT NULL,                -- $type<FullBriefing>()
  model            text,                          -- model id used for compose
  compose_fallback boolean NOT NULL DEFAULT false, -- deterministic fallback delivered

  email_send_id text FK -> email_sends NULL,      -- delivery side-effect link
  row_version   bigint NOT NULL DEFAULT 0,
  ...lifecycle_dates,

  UNIQUE(user_id, briefing_date)
)
```

`BriefingGather` and `FullBriefing` live in `@alfred/contracts/briefing.ts`. Each `*Contribution` type is exported separately so future integrations add their slice without touching shared types. `gather` and `full_briefing` use Drizzle `.$type<T>()` for compile-time safety; runtime validation is the composer's structured-output contract.

**Why `briefing_date` + `timezone` as separate columns, not a `timestamptz`.**

`briefing_date` is the *identity* of the briefing — the unique index, the query key for "yesterday's briefing", the idempotency key for `notify()`. Querying by calendar day must not require tz math at read time. A `timestamptz` encodes an instant + offset, not a calendar date in an IANA zone — Postgres stores the offset, not the IANA name, so "+05:30" identifies Asia/Kolkata *or* Asia/Colombo *or* a manual offset. The IANA name is the canonical zone identity (DST rules, historical offset changes); we need both pieces independently, captured at compose time. Cosmetic ergonomics via a `briefingDateAndTz` spread helper in `packages/db/src/helpers.ts`, same shape as the existing `lifecycle_dates` spread.

**Composer output schema.**

```ts
// packages/contracts/src/briefing.ts
export const briefingComposerSchema = z.object({
  breakingSummary: z.string().min(1).max(2000),
  fullBriefing: z.object({
    headline: z.string().min(1).max(200),
    sections: z.array(z.object({
      source: gatherSourceSlugSchema,             // 'email' | 'calendar' | 'integration_activity' | 'weather' | 'day_of_week'
      label:  z.string().min(1).max(80),
      body:   z.string().min(1).max(2000),
      why:    z.string().min(1).max(500).optional(),
      references: z.array(z.string().min(1)).max(12).optional(),
    })).max(12),
    auditSummary: z.string().min(1).max(2000).optional(),
  }),
});
```

`briefingComposerSchema` is model-facing and deliberately excludes `sourcePanels`. The persisted `FullBriefing` type/schema extends the composer output with deterministic `sourcePanels` after reference resolution:

```ts
type FullBriefing = BriefingComposerOutput['fullBriefing'] & {
  sourcePanels?: BriefingSourcePanel[];
};
```

Composer prompt explicitly enumerates every available reference. Example fragment passed to the LLM:

```
Available references (use ONLY these IDs; do not invent):
  Activity:  [activity:github:pr:warden#9 - "Review requested on warden#9"]
             [activity:provider:deploy:alfred-web:2026-06-02T08:12Z - "alfred-web deploy failed, then recovered after 6 attempts"]
  Meetings:  []
  Threads:   [email:thr_abc123 - "Quarterly check-in"]

When citing one of the above in your prose, use [[<kind>:<id>]] verbatim.
Do NOT emit URLs. Do NOT emit markdown bold or links for entity references.
```

**Reference resolution layer.**

```ts
// packages/api/src/modules/briefing/references.ts
type Segment =
  | { kind: 'text';    value: string }
  | { kind: 'activity'; id: string; provider: IntegrationSlug; activityCategory: string; providerKind: string; title: string; url?: string }
  | { kind: 'meeting'; eventId: string; title: string; start: string; calendarUrl: string }
  | { kind: 'email';   threadId: string; subject: string; gmailUrl: string };

export function resolveBriefingReferences(
  markdown: string,
  gather: BriefingGather,
): { segments: Segment[]; unresolved: string[] };
```

`renderBriefingEmail(segments) → { html, text }` and `renderBriefingApp(segments) → React.ReactNode` are the two surface-specific renderers. Unresolved placeholders fall back to a plain-text label and append to `unresolved`; the workflow logs them and a hook count surfaces in observability — drift between gather and composer is a real risk and we want it visible. The breaking-summary and full-briefing share the same resolver — one source of composer truth, two renderers.

**Full briefing UI.** The email stays intentionally short and ends with a `View full briefing` link into the in-app detail route. The full page can borrow the chat page's existing visual grammar: assistant prose as the main body, run/source accordions for details, source rows for provenance, and compact disclosures for "why included." Do not render raw model reasoning or chain-of-thought. `sections[].why` is a user-facing inclusion rationale ("included because the deploy loop took 47 minutes and needed six attempts"), while `auditSummary` is a bounded composition note suitable for a muted "Briefing notes" disclosure or diagnostics. The raw gather payload remains available in the row for audit/replay, but the UI renders `sourcePanels`: a normalized display model generated deterministically from gather + resolved references after compose, not model-authored.

**Replicache integration.**

- `IDB_KEY.BRIEFING` entry in `packages/sync/src/keys.ts` — actual prefix `briefing/`. ADR-0041's original day-keyed row became slot-keyed in ADR-0048; current per-row key is `briefing/{briefingDate}/{slot}`.
- Read schema in `packages/sync/src/schemas.ts` includes `breakingSummary`, `fullBriefing`, `briefingDate`, `slot`, `timezone`, `status`, `sendDecision`, `gather`, `rowVersion`.
- No client mutators at v1 — the workflow is the only writer. A future "regenerate" mutator flips `status` back to `'pending'` and re-enqueues the workflow.
- Pull window: **last 30 days**. Older briefings reachable via an on-demand `/api/briefings/history?before=...` route. Keeps IndexedDB cache bounded — at up to two rows/day, 30d is ~60 rows × small jsonb each.

**Gather extensibility.**

```ts
// packages/contracts/src/briefing.ts
export interface BriefingContributor<T> {
  source: GatherSourceSlug;
  collect(args: { userId: string; date: string; timezone: IanaTimezone }): Promise<T | null>;
}
```

Each contributor returns `null` if its integration isn't connected or the OAuth scope is missing — composer prompt handles the empty cases ("no meetings today" / "weather unavailable"). Operational integrations bolt on by adding an `integration_activity` producer; only truly distinct briefing roles should add a new `GatherSourceSlug`.

**v1 source notes.**

- **Email** — reuses `email_triage` joined to `documents` (no new query path).
- **Calendar** — requires `calendar.events.readonly` added to `GOOGLE_FEATURE_SCOPES.briefing` (currently `briefing` includes only `gmail.readonly`). Same Google OAuth client; user re-consent on next OAuth refresh or feature reconnect.
- **Integration activity** — normalized operational updates across connected systems. GitHub is the first planned direct producer (PRs awaiting review + yesterday's authored commits; requires `repo` scope on the GitHub OAuth app). Classic OAuth `repo` is broad, but pragmatic for private repo activity in this single-user v1; re-consent must be explicit and user-facing, and a GitHub App / fine-grained-token shape should be revisited if the scope becomes uncomfortable. Other providers, such as deployment, incident, domain, billing, security, docs, or project-management systems, add producers only when their integrations exist. Email triage can backfill provider activity before direct APIs exist, marked `source='email_triage'`.
- **Weather** — Open-Meteo (no API key, generous free tier). Location resolved from `user_preferences.location` (added alongside this ADR) or falls back to the IANA timezone's principal city. Cached in Redis per `(lat, lng, briefingDate)` for the day.
- **Day-of-week + holidays** — pure `Intl.DateTimeFormat` on the user's timezone; holidays via a small `@alfred/contracts` table covering US/IN holidays at v1.

**Integration activity rollup.** The briefing is not a raw event feed. Producers may emit many raw events, but the gather normalizes and rolls them up into `IntegrationActivityItem`s before compose:

```ts
type IntegrationActivityItem = {
  id: string;
  provider: IntegrationSlug;
  source: 'direct_api' | 'email_triage';
  activityCategory: 'work' | 'deploy' | 'incident' | 'account' | 'billing' | 'security' | 'usage' | 'other';
  providerKind: string; // provider-scoped, e.g. github.pr_review_requested, some_provider.deployment.failed
  title: string;
  status?: 'open' | 'succeeded' | 'failed' | 'resolved' | 'needs_attention';
  severity?: 'info' | 'warning' | 'critical';
  occurredAt: string;
  url?: string;
  relatedRepo?: string;
  rollup?: { eventCount: number; attemptCount?: number; durationMinutes?: number; suppressedEventIds?: string[] };
};
```

Resolved noise is suppressed by default. Example: a deployment from any connected deployment provider that failed once and then succeeded should not brief the user. It becomes brief-worthy when the cluster is still unresolved, has critical severity, required clear user attention, crossed a pain threshold (for example >=3 failed attempts or >30 minutes from first failure to recovery), or is a notable day-level accomplishment. This is intentionally "intelligent and intuitive": the briefing should say "the build finally recovered after a rough deploy loop" only when that is a meaningful event in the user's day.

**Empty-state behavior.** A day with no meetings, no important email, and no meaningful integration activity does *not* skip — the empty state is itself the content. The composer prompt's tone rule: *"On a quiet day, acknowledge the quiet — name what didn't happen, recognize recent effort if memory carries it, leave the user feeling earned rest, not informational void."* The dimension worked example *"no PR activity. After shipping 11k lines of warden security yesterday, you've earned the quiet"* is baked into the prompt as a canonical example.

**Failure modes.**

- **Composer LLM unavailable.** Workflow falls back to a deterministic template render of the gather data, sent under the same idempotency key. If delivery succeeds, the briefing row is `status='sent'` with `compose_fallback=true`; this is degraded compose, not delivery failure. Better to ship the gather than nothing.
- **Send failure (Resend outage).** Briefing row stays at `status='failed'`. `breakingSummary` and `fullBriefing` are already composed; the in-app surface still renders. A per-row "resend" affordance lets the user retry once the upstream recovers.
- **Reference resolution miss.** Unresolved `[[activity:foo]]` falls back to the inner label `"foo"` as plain text; `unresolved[]` is logged. Composer prompt drift is the most likely cause; the log surfaces it.

**Cost calculus (single user).**

| Phase | Calls/day | Tier | $/day |
| --- | --- | --- | --- |
| Gather (no LLM) | 5 contributors | — | 0 |
| Compose | 1 | boss | ~$0.02 |
| Send | 1 | — | 0 |
| **Total** | | | ~$0.02/day |

vs the previous deterministic-render path (~$0/day, deterministic prose) — the delta is the cost of the warmth and judgment that the dimension example demonstrates is the actual product surface.

**Alternatives.**

- (a) **Single email with collapsible "full briefing" disclosure.** Rejected — HTML email rendering of per-source drill-downs is awkward across clients; mobile especially mangles disclosure widgets; loses a place for briefing history. Email should stay summary-only with a `View full briefing` link.
- (b) **Boss-agent-driven gather (LLM picks which tools to call per day).** Rejected — daily user-facing surface on top of m13 infrastructure still under construction. "What matters" is a product decision (same five sources every day), not a per-run reasoning decision; pushing it into a boss burns tokens to re-derive a fixed answer.
- (c) **Cheap-tier compose model.** Rejected — the warmth and judgment in the dimension example are not cheap-model outputs. Saving ~$0.01/day on the most-visible artifact is the wrong trade.
- (d) **Plain markdown without reference placeholders (LLM emits URLs inline).** Rejected — URL hallucination on a daily user-facing email is unacceptable; in-app entity chips can't be reconstructed from `<a href>`; styling responsibility belongs to surfaces, not the LLM.
- (e) **Single `timestamptz briefing_at` column for date + tz.** Rejected — loses the calendar-date identity needed for the idempotency unique index and history queries; Postgres timestamptz stores offset, not IANA zone name; canonical zone identity is lost.
- (f) **Append-only `briefing_runs` history per render.** Rejected — at single-user scale, day-by-day overwrite is the natural model; render history is a feature nobody asked for; `agent_runs` already audits the workflow itself.

**Open.**

- Future "regenerate" mutator for the in-app surface — server-authored only at v1.
- `briefing_history` route shape for pulls older than 30 days. Likely a simple paginated read; no Replicache involvement.
- Whether the composer prompt should evolve to consume `person_profiles` (ADR-0031) once dossiers exist — so "Alice requested your review" becomes "Alice (eng lead at $company) requested your review". Forward-compatible via the reference resolver; the gather payload would carry resolved dossier slices alongside.
- Holiday calendar coverage beyond US/IN — add per locale as needed; the const table is the right scale at v1.
- How much raw gather data the full briefing page should expose. Default v1: render sections, entity/activity chips, source-backed `why` disclosures, normalized `sourcePanels`, and a muted `auditSummary`; keep raw gather as stored data for audit/replay rather than rendering directly from each contributor shape.

---

## ADR-0042 — Email triage v2: layered pipeline with deterministic sender extraction + cheap classifier + boss escalation + async dossier trigger

**Decision.** Email triage becomes a four-step workflow: `extract-sender-context → classify → [deepen?] → apply-label`. The middle two steps form a layered classifier: a cheap-tier LLM handles the obvious bulk from email + `SenderContext` only; a boss-agent `deepen` step fires only when the gate's three conditions are met and is the only path where broader user bio/profile context affects tagging. The deterministic extraction step at the head exists so neither LLM step has to parse email headers — that's regex work. The dossier-research side-effect for unknown important human senders fires async from `deepen`, with TTL-based caching of completed dossiers in `person_profiles` once ADR-0031 is implemented.

Seven coordinated micro-decisions:

1. **Deterministic `extract-sender-context` step.** Parses `From:` + body and emits a typed `SenderContext` (`{ fromKind, bodyActor?, effectiveAuthor, botSlug? }`). Lives in `packages/api/src/modules/triage/sender-context.ts`. Zero LLM cost; ~5ms; output threaded through workflow state into the classifier.
2. **Cheap classifier consumes `SenderContext`, not user bio.** Today's classify step keeps its cheap-tier model and 10-bucket taxonomy; the system prompt evolves to consume `SenderContext` as a first-class input. Rule #9 splits into 9a/9b/9c: bot review comments → `fyi`; severity-suspect bot alerts → classify on body content alone; unknown service envelopes → today's behavior. Bot identification stops being prompt-derived; severity judgment stays prompt-derived. The cheap path deliberately stays email-only: it does not load the user's biography, long-term memory, or profile context. Bio-aware tagging belongs to `deepen`, so obvious mail stays fast and cheap while ambiguous/high-impact mail gets the richer boss pass.
3. **`deepen` step, boss-tier, gated.** Eligibility is any of: classifier `confidence < 0.7`, OR `senderContext.botSlug ∈ SEVERITY_SUSPECT_BOTS`, OR `effectiveAuthor === 'person'` AND sender not in confirmed contacts. Initial live rollout executes only the severity-suspect bot branch; the low-confidence and unknown-human branches run in shadow/log-only mode (`wouldDeepen`, reason, classifier distribution) until the observed rate is acceptable. The live `deepen` path runs a brief-only `AlfredAgent` loop (ADR-0040 sentinel) with a read-only tool surface: `system.read_user_context`, `github.list_repos`, `gmail.thread_history`. Web search is *not* in the deepen tool surface — that budget belongs to the async dossier workflow (see "deepen step shape" below). Outputs a refined category, a severity flag, and an optional `request_dossier(personEmail)` side-effect. Failure (model timeout, m13 hiccup) falls back to the cheap classifier's output — triage never blocks on the boss.
4. **Async dossier auto-trigger via `person-research`.** When `deepen` returns `request_dossier` for an unknown human in `urgent` / `action_needed` / `awaiting_reply`, enqueues the ADR-0031 workflow as a side-effect. The current email's classification does NOT wait — it ships on classifier + deepen output alone. Future emails from the same sender benefit from the now-cached dossier.
5. **Dossier cache via `person_profiles` with confidence-tier TTL.** ADR-0031's saved profile IS the cache; no new table. Cache key is the stable sender identifier: `email` for direct senders, `service:handle` for body actors (`github:coderabbitai`). TTL by `identity_confidence`: ≥0.9 → 90d, 0.7-0.9 → 30d, <0.7 → 7d. Re-research fires when stale AND sender lands in an important triage category (or via explicit user refresh).
6. **`system.read_user_context` as the fast profile surface.** Boss and sub-agents can query compact user context through a system tool, not a loadable `memory` integration. The tool is always available, autonomy-overridden like other `system.*` tools, and returns bounded, provenance-aware slices from user facts, preferences, entities/relations, semantic memory chunks, and later saved `person_profiles`. Postgres remains the source of truth; Redis is a read-through cache for the derived profile/slices (for example `alfred:user-context:{userId}:v1`) and is invalidated when memory/facts/preferences/profile rows change. The model-facing concept is "user context" because this is runtime context the boss needs for judgment, not a generic memory corpus dump.
7. **Coverage observability.** New logging event `triage.sender_extraction` per email, recording `{ fromKind, bodyActor?, effectiveAuthor, botSlug?, parserHit?, classifierConfidence, wouldDeepen, wouldDeepenReason?, deepenExecuted, shadowOnly }`. The bot allowlist and body-actor parser set grow from observed log data, not speculation.

**Why this is its own ADR.** ADR-0025 #1's 2026-05-21 amendment widened *what* triage outputs (6 → 10 buckets). This ADR widens *how* triage decides — different cost/latency tradeoffs, a new pipeline step, a new dependency on m13's boss runtime, a new auto-trigger contract amending ADR-0031. Different shape, different blast radius.

**Pipeline.**

```
ingest doc (gmail.poll_recent or gmail.poll_history)
  ↓
extract-sender-context           deterministic, ~5ms
  ↓                              SenderContext { effectiveAuthor, ... }
classify                          cheap LLM, ~500ms
                                  email + SenderContext only; no bio/profile lookup
  ↓                              category, confidence, rationale
[deepen?]                         live iff senderContext.botSlug ∈ SEVERITY_SUSPECT_BOTS
                                  shadow iff confidence < 0.7
                                  shadow iff effectiveAuthor === 'person' AND not in contacts
                                  boss may query system.read_user_context
  ↓                              refined category, severityFlag, dossierRequest?
apply-label                       deterministic, Gmail messages.modify
                                  + thread-sibling alfred-label strip
[fire-and-forget]
  person-research workflow if dossierRequest
```

**`SenderContext` shape (in `@alfred/contracts`).**

```ts
export const SENDER_KIND = ['person', 'service', 'unknown'] as const;
export type SenderKind = (typeof SENDER_KIND)[number];

export const EFFECTIVE_AUTHOR = ['bot', 'person', 'service', 'unknown'] as const;
export type EffectiveAuthor = (typeof EFFECTIVE_AUTHOR)[number];

export const BOT_SLUGS = [
  'coderabbit', 'copilot-review', 'github-actions', 'dependabot', 'renovate',
  'vercel', 'sentry', 'stripe-billing', 'google-security', 'datadog',
] as const;
export type BotSlug = (typeof BOT_SLUGS)[number];

export interface SenderContext {
  fromKind: SenderKind;
  bodyActor?: {
    kind: 'bot' | 'person' | 'unknown';
    name: string;            // 'coderabbitai', 'alice', 'dependabot[bot]'
    handle?: string;         // GitHub handle when extractable
  };
  effectiveAuthor: EffectiveAuthor;
  botSlug?: BotSlug;         // populated when effectiveAuthor === 'bot' AND recognized
}
```

**Severity-suspect bot allowlist.** A const subset of `BOT_SLUGS` indicating "this bot CAN be urgent, so escalate to `deepen` even if the cheap classifier said `fyi`":

```ts
export const SEVERITY_SUSPECT_BOTS: ReadonlySet<BotSlug> = new Set([
  'sentry',           // alert: errors spiking
  'stripe-billing',   // payment failure breaks access today
  'google-security',  // sign-in verification, account compromise
  'vercel',           // deploy fail on user's own project
  'datadog',          // SLO breach, incident
]);
```

CodeRabbit / Copilot review / Dependabot / Renovate / GitHub Actions are deliberately *not* in this set — their messages are advisory in 99% of cases. If a Dependabot PR is genuinely severe (high-CVE security alert), the classifier's text-content reasoning catches it on rule 9a's exception clause, not via the sender-severity-suspect heuristic.

**Body-actor parsers (v1).** Three sources cover ~80% of bot/human disambiguation in real inboxes:

| Source | Detection | Parser |
| --- | --- | --- |
| GitHub          | `From: noreply@github.com`              | Extract `**actor**` markdown bold in first ~10 lines; `[bot]` suffix → bot; otherwise person |
| Google Calendar | `From: calendar-notification@google.com`| Parse iCal `ORGANIZER` field or "organizer:" line in body                                   |
| Linear          | `From: notifications@linear.app`         | Parse "Comment from {actor}" / "{actor} commented" line                                     |

Each parser is ~30 LOC, tested with fixture emails in `packages/api/test/triage/sender-context.test.ts`. Long-tail sources (Notion, Slack, Vercel deploy notifications, Jira) fall through to `effectiveAuthor: 'unknown'` — the escalation gate's `confidence < 0.7` clause is the safety net.

**Classifier system-prompt evolution.** Rule #9 today (*"Automated alerts that demand a remediation step → 'urgent' if same-day else 'action_needed'. NOT 'fyi'."*) splits into:

```
9a. Bot review comments (effectiveAuthor === 'bot' AND botSlug ∈
    {coderabbit, copilot-review, github-actions, dependabot, renovate}):
      → 'fyi'. Advisory at best; the user can scan when they want.
      EXCEPTION: escalate to 'action_needed' or 'urgent' only if body text
      indicates a security advisory (CVE, vulnerability, secret exposed),
      regardless of bot identity.

9b. Severity-suspect bot alerts (effectiveAuthor === 'bot' AND
    botSlug ∈ SEVERITY_SUSPECT_BOTS):
      Classify on body content alone — 'urgent' if same-day-actionable
      (Sentry error spike, Stripe payment failure breaking access,
      Google sign-in verification, Vercel deploy failure on the user's
      project), 'action_needed' otherwise.

9c. Unknown bot or service envelope (effectiveAuthor === 'service' AND
    no botSlug, OR effectiveAuthor === 'unknown'):
      Today's behavior — classify on body content alone.
```

**`deepen` step shape.** Boss brief-only run with a fixed brief:

```
Refine the triage classification for this email. The cheap classifier
output: {category, confidence, rationale}. The sender context: {SenderContext}.

Use the read-only tools to gather context:
  - system.read_user_context : user's compact bio/profile, preferences, known contacts,
                               important people, current company/projects, and saved dossiers
  - github.list_repos   : is the user's relationship to a service active?
  - gmail.thread_history: prior interactions with this sender

Return:
  - refinedCategory: one of TRIAGE_CATEGORIES (may equal cheap classifier output)
  - severityFlag:   'severe' | 'normal' | 'low'
  - dossierRequest?: { personEmail } if web search would be valuable but
                     you didn't run it (the async dossier workflow handles it)
```

The boss is *not* invited to call `web_search` directly — that's web search budget that belongs to the async dossier workflow, not to per-email triage. The `dossierRequest` side-effect surfaces the request; the triage workflow enqueues `person-research` separately.

**User-context tool.** `system.read_user_context` is the always-available profile/memory read surface for the boss runtime. It should accept a bounded query shape such as `{ query?: string; include?: ('bio'|'preferences'|'contacts'|'projects'|'relationships'|'dossiers')[]; subjectEmail?: string; subjectHandle?: string }` and return a compact result with provenance. It may read from Redis first for speed, but the cached value is derived from Postgres-owned state (`user_facts`, `user_preferences`, `entities`, `entity_relations`, `memory_chunks`, and eventually `person_profiles`). Redis loss only causes a cache miss; it must not lose memory.

**Shadow rollout.** `triage.sender_extraction` logs both eligibility and execution: `wouldDeepen`, `wouldDeepenReason`, `deepenExecuted`, and `shadowOnly`. v1 executes `deepen` for `severity_suspect_bot`; `low_confidence` and `unknown_human` are shadow-only until each branch clears its own promotion gate. `low_confidence` can go live after 200 triaged emails or 7 days of logs if it fires on <=15% of mail; above that, tune the confidence threshold before enabling. `unknown_human` can go live only if it fires on <=5% of mail and a manual spot-check shows the matched senders are real people worth dossier work. This keeps the high-signal safety branch live without accidentally routing a large fraction of inbox traffic through boss-tier due to uncalibrated confidence scores or sparse contacts.

**Failure model.** If `deepen` fails (model timeout, boss runtime error, m13 phase regression), the workflow logs the failure and proceeds to `apply-label` with the cheap classifier's output. Triage never blocks; the user always gets a label. The History tab surfaces the failure for diagnosis.

**Cost calculus (100 emails/day single user).**

| Phase | Calls/day | Tier | $/day |
| --- | --- | --- | --- |
| Extract sender context  | 100       | regex    | 0       |
| Classify                | 100       | cheap    | ~$0.01  |
| Deepen                  | ~10 (10% escalation) | boss    | ~$0.20  |
| Dossier (new sender, rate-limited) | ~1 | research | ~$0.05  |
| **Total**               |           |          | **~$0.26/day** |

vs **pure boss agent on every email**: 100 × ~$0.02 = ~$2.00/day. **10x cost reduction** for the obvious 90% of email, with the boss's judgment exactly where it adds value. The bigger structural argument is latency: the cheap path returns a Gmail label in ~1s; pure-boss takes ~10s. For an inbox-tagging job that fires per-message, that delta is the difference between "feels real-time" and "feels broken."

**Alternatives.**

- (a) **Pure boss agent on every email.** Single mental model; richest reasoning. Rejected — 10x cost, 10x latency, depends on m13 phase 4 landing solid before m9 cleanup can ship. At single-user scale cost isn't crippling, but the latency story is the real disqualifier.
- (b) **Bot detection inside classifier prompt only.** Cheapest to ship. Rejected — classifier becomes parser + judge; parsing GitHub email headers in natural language is exactly what regex is for; prompt-rule precedence degrades past ~12 rules (we're at 11 today).
- (c) **Post-classifier deterministic re-score.** Classifier runs unchanged; a deterministic step adjusts output. Rejected — classifier's `rationale` field gets out of sync with the final category ("Rationale: code review owed. Category: fyi." reads as a bug to anyone auditing).
- (d) **Sync dossier in `deepen`.** Boss blocks on web search + dossier compose during triage. Rejected — dossier work is 30-60s; blocking triage on it means the Gmail label arrives 30s late. Async via `person-research` is the right cadence split.
- (e) **Speculative dossier on every new human sender.** Rejected — generates dossiers for cold-outbound sales pitches and one-off senders. Wasteful. The gate's "important triage category" clause is the right filter.
- (f) **User-triggered dossiers only (no auto-trigger).** Rejected — the whole point of "if it's a human, maybe Google search them" is for Alfred to do the work proactively; the escalation gate already has the signal it needs.
- (g) **Pass user bio/profile context into the cheap classifier.** Rejected for v1 — it makes every email classification depend on a memory/profile fetch and widens the prompt for the 90% obvious path. Bio-aware tagging is valuable, but it belongs to the boss `deepen` path where the added context can actually adjudicate ambiguity.
- (h) **Make Redis the source of truth for user context.** Rejected — user profile and memory state must survive Redis loss and remain inspectable/editable through the durable memory tables. Redis is a speed layer over a compact derived profile, not the memory store.
- (i) **Enable every `deepen` trigger live on day one.** Rejected — classifier confidence calibration and contact/memory coverage are unknown. Live severity-suspect bots are narrow and high-signal; low-confidence and unknown-human branches need shadow data first.

**Open.**

- Bot allowlist storage migration to DB-backed when it grows past ~20 entries. Hardcoded const is the right scale at v1.
- Body-actor parsers beyond GitHub / Calendar / Linear — add per observed-data evidence, not speculation.
- Email-tagging leniency and activity extraction from service mail are related but separate from this ADR's core shape. Revisit after the shadow logs show how often service envelopes / provider emails are being over- or under-tagged.
- Whether to surface escalation reasons in the History tab UI ("deepened because confidence was 0.6") for tunable observability.
- Whether `deepen`'s read-only tool surface needs a per-tool `read_only=true` flag at the registry level, or whether the tool selection in the workflow brief is sufficient (current take: brief sufficient; structural flag only if a future workflow needs to enforce read-only across all calls).

---

## ADR-0043 — Integration write surface: tools may write, authorization is the user action policy

**Decision.** Integrations may expose **write tools** (send mail, create/modify calendar events, create Drive files, edit a doc, etc.). Authorization for any write is the composition of three layers we already have, evaluated in order:

1. **Tool registry** — a write tool exists only if it is registered (m13 work). No registration, no write.
2. **Active tool exposure** / `workflows.allowed_integrations` — SDK tools are built only from `state.activeIntegrations`, whose initial seed is strict `@`-mentions intersected with `workflows.allowed_integrations`; later expansion goes through `system.load_integration`, which enforces the same cap (ADR-0026/0040). A workflow whose allowlist excludes an integration can never get that integration's tools exposed to the model. If a future generic dispatch endpoint bypasses SDK tool exposure, it must add an equivalent dispatcher-side active-integration check.
3. **User action policy** (ADR-0034) — the resolved `policy mode` (`autonomy | gated`) decides whether the call executes immediately or stages for HIL. Default `gated`.

No write is blocked structurally by `risk_tier` or by a hardcoded tier; **the user owns the policy** (reaffirms ADR-0034 alt-(f)). This **supersedes ADR-0033's blanket rule** that integrations "expand the *read* surface, never the *write* surface, regardless of OAuth scopes available on the underlying token."

**Why this is its own ADR.** ADR-0033 made an absolute architectural promise — no write tools, ever, regardless of token scope — as a safety stance for the *unattended briefing agent*, written before the action-policy machinery existed. ADR-0034 then built per-call gating but never revisited 0033's promise. Expanding the write surface for the interactive boss agent and (per the product goal) for user-authored workflows forces the question into the open: writes are now first-class, and the guarantee migrates from architecture to configuration.

**The trade we are making (stated honestly).** *Before:* a background workflow architecturally could not send mail — its tool surface had no write tools. *After:* "a background workflow won't send mail unannounced" rests on the policy **default** being `gated`. This is still safe in operation — a `gated` write tool in an unattended run parks on `wakeCondition.kind='hil'` and fires the debounced approval email (ADR-0034); nothing sends without a human decision. But the protection is now a **default, not an invariant**. We accept this because (a) a personal assistant must act, not just read; (b) user-authored workflows will legitimately need to send/create across one or multiple integrations; (c) ADR-0001's single-user framing makes "the system protects future-you from current-you" hostile, not helpful (ADR-0034 alt-(f)).

**What stays true.** The briefing **compose** path remains tool-free by construction (ADR-0041): it is a single structured-output `generateText` over the gather, not an agent loop, so it physically cannot write regardless of policy. "Safety through architecture" survives where it is cheap — a read-only surface stays read-only by being given no write tools and no write integration in its allowlist — and "safety through policy" covers everything that genuinely needs to act.

**Default posture.** New write tools register at whatever `riskTier` the author assigns (UX hint only; ADR-0034) and inherit the user's `default_mode = gated`. The user opts a tool or integration into `autonomy` explicitly (per-integration mode or per-tool override). The forward-compat `set_action_policy` tool (ADR-0034 out-of-scope slot) is the eventual chat path for "trust gmail entirely"; not built here.

**Alternatives.**

- (a) **Keep ADR-0033 absolute; only ever read.** Rejected — defeats the product; a personal assistant that can't send a reply or create a doc is a search box.
- (b) **Reading A: writes for the interactive boss agent only, never for background workflows.** Rejected (considered and dropped 2026-05-27) — the roadmap has workflows that send/create unattended; walling background runs off from writes forces a second, parallel authorization model later. The policy gate already handles unattended writes correctly (park + notify).
- (c) **Hardcode a structural write-block for high `riskTier` regardless of policy.** Rejected — paternalism; restates ADR-0034 alt-(f).

**Cross-ref.** Amends ADR-0033. Composes with ADR-0034 (policy/staging), ADR-0026/0040 (active-integration seed + load cap), and ADR-0044 (the scope posture supplying the OAuth grants these tools call).

---

## ADR-0044 — Google OAuth posture: multi-tenant-capable architecture, Production-unverified single-tenant operation, least-privilege scope tiers

**Decision.** Alfred is **architected multi-tenant** (per-user `integration_credentials`, per-user `user_action_policies`, `user_id` partitioning throughout) but **operated as a single tenant** today. The Google OAuth consent screen moves from **Testing → Production publishing status, deliberately unverified**. Scopes are requested **least-privilege, tracking the registered tool set**; we extend freely into **sensitive** scopes (app verification, no security assessment) and take exactly **one restricted** scope as a knowing concession (`gmail.modify` — reading and labeling mail is the product). The granted set is the union of scopes required by *currently registered* tools; adding a scope is an incremental re-consent, after which the refresh token is no longer subject to Testing mode's 7-day expiry (it is still revocable and subject to Google's normal token limits).

**Why this is its own ADR.** ADR-0001 fixed single-user scope. This ADR records that single-user is the current *operating mode*, not an *architectural ceiling* — and reasons through the OAuth verification economics that make "go public someday" a submission + auth-policy flip rather than a rewrite. A future reader will ask "why is the production app intentionally unverified, and why these specific scopes?"; this answers both.

**The verification economics (the load-bearing facts).**

- **Testing publishing status** (where we were): users must be listed as test users, non-profile authorizations expire after 7 days, and there is a 100-test-user cap. The 7-day refresh-token expiry is the operational pain on an always-on assistant.
- **Production, unverified:** anyone can attempt consent, the unverified-app warning appears for unapproved sensitive/restricted scopes, and a 100-new-user cap applies while the app remains unverified. At single-tenant scale every downside is a non-issue; the win is avoiding Testing mode's 7-day token expiry. **We never submit for verification, so there is nothing to be rejected** — the historical "Google would never approve it" wall exists only on the *verified-public* path.
- **Google scope tiers** set the bar to ever go public:
  - **Non-sensitive** (`drive.file`, `openid`, `email`): no sensitive/restricted scope review; a public branded app can still need basic app/brand verification, but this is not the expensive path.
  - **Sensitive** (`gmail.send`, `calendar.events`, `documents`, `spreadsheets`, `presentations`): app verification — privacy policy, demo video, logo, justification. No security assessment.
  - **Restricted** (`gmail.readonly`, `gmail.modify`, full `drive`): restricted verification **plus a security assessment if restricted-scope data is stored or transmitted through servers**. This is the real public wall for a solo dev.

**Scope set (least-privilege, tracks tools).**

| Surface | Scope | Tier | Why |
| --- | --- | --- | --- |
| Identity | `openid`, `userinfo.email` | profile-only | sign-in / credential row identity |
| Drive (create) | `drive.file` | non-sensitive | create/edit Alfred-owned docs/sheets/slides (the "make me a PPT" path); also gains per-file access to files the user picks via Google Picker — no restricted scope needed |
| Gmail send | `gmail.send` | sensitive | send / reply |
| Calendar | `calendar.events` | sensitive | read + create/update/delete events (narrower than full `calendar`) |
| Workspace edit *(optional power tier)* | `documents`, `spreadsheets`, `presentations` | sensitive | edit *existing* Workspace files the user already has. Default **off** in favor of `drive.file` + Picker; enable when a tool genuinely needs cross-file edit. Listed because they do not trigger the restricted-scope security assessment |
| Gmail read + label | `gmail.modify` | **restricted (the one concession)** | read message bodies, apply/remove labels (triage, briefing, search). `gmail.readonly` is subsumed |

**Explicitly NOT requested:** `https://mail.google.com/` (full IMAP/delete), `gmail.settings.*`, full `drive` / `drive.readonly`, Admin SDK, Contacts, Tasks — none map to a current tool, and each widens breach radius and verification surface.

**Consequences for "go public."** The public path is: verify the sensitive scopes + commit to the security assessment for the `gmail.modify` family (the single restricted scope, because Alfred stores/transmits Gmail data server-side) + remove ADR-0009's one-email allowlist for open signup. Keeping the restricted surface to **one** scope family is deliberate — it makes the eventual restricted-scope review as small as Google allows. Multi-tenant architecture means none of this is a rewrite.

**Resume framing.** The defensible artifact is the *documented trade-off*, not a paid audit: "architected multi-tenant, operated single-tenant Production-unverified to avoid a restricted-scope security assessment disproportionate for a portfolio project; least-privilege scopes keep the verification surface minimal; going public is a verification submission + allowlist removal."

**Operational steps (no code).** Flip the GCP consent screen Testing → Production; re-consent the owner account once under the broadened scopes to get a refresh token outside Testing mode's 7-day expiry; record the "to go public" checklist alongside this ADR.

**Source check (2026-05-27).** Verified against Google's OAuth, Drive, Gmail, Calendar, Sheets, and Slides docs: Testing-mode offline grants expire after 7 days for non-profile scopes; In Production unverified apps show the warning and have a 100-new-user cap; `drive.file` is non-sensitive and per-file; Gmail `gmail.send` is sensitive while `gmail.readonly`/`gmail.modify` are restricted; restricted scopes require a security assessment when restricted data is stored or transmitted through servers. Key refs: [OAuth token expiry](https://developers.google.com/identity/protocols/oauth2), [app audience/user cap](https://support.google.com/cloud/answer/15549945), [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [restricted scopes](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

**Alternatives.**

- (a) **Stay in Testing mode.** Rejected — the 7-day refresh-token expiry on an always-on assistant is a recurring outage; Production-unverified fixes it for free.
- (b) **Pursue verification + security assessment now.** Rejected — recurring paid audit, disproportionate for current scope; nothing forces it at single-tenant.
- (c) **Broad "grant-all" restricted scopes (full `drive`, full mailbox).** Rejected (reversed an earlier inclination, 2026-05-27) — maximizes breach radius and verification surface and directly fights the public-someday goal; the capability gained is "edit files the user never opened with Alfred," exactly what a public app couldn't keep.
- (d) **`drive.file` only, no sensitive scopes.** Rejected — too narrow; can't send mail or manage calendar, which the assistant needs. Sensitive scopes cost only brand verification, so we take them.

**Open.**

- Whether to enable the `documents`/`spreadsheets`/`presentations` power tier or stay on `drive.file` + Picker — decide when a cross-file-edit tool is actually built.
- Exact "go public" checklist contents (capture alongside this ADR when the flip is scheduled).
- **Self-host-per-user as a third path:** Alfred could ship as a self-hosted instance where each user runs their own GCP project + Production-unverified consent screen. Then *every user is their own OAuth developer account*, and the restricted-scope security assessment does not apply to a centralized public app because there is no centralized public OAuth client. Strong candidate; revisit if/when distribution becomes real.

**Cross-ref.** Records the operating mode under ADR-0001; supplies the OAuth grants ADR-0043's write tools call; the eventual public flip touches ADR-0009 (auth allowlist).

**Amendment (2026-06-08) — never public → grant-all in one consent; reverses alt-(c).**

The load-bearing assumption of the original decision — "go public someday" — is retired. Alfred is now explicitly a **single-tenant, Production-unverified app forever**. That collapses the entire verification calculus: an unverified Production app can request *any* scope, restricted included, with **no CASA, no security assessment, no review** — the sole owner clicks through the one-time "unverified app" warning and grants the lot. The 100-new-user cap and the unverified warning are non-issues at single-tenant scale; the 7-day Testing-mode token expiry is already gone (we are in Production). There is **nothing to verify and nothing to be rejected**, so least-privilege buys *nothing* operationally — it bought only a smaller eventual verification surface, and that goal no longer exists.

Therefore:

- **Onboarding requests the full grant in one consent** (no per-feature opt-in step). `/api/integrations/google/connect` with no `?features` param resolves to `ALL_GOOGLE_SCOPES`. The `?features=` param survives for *targeted reconnects* only.
- **This reverses alt-(c)** ("broad grant-all restricted scopes"), rejected 2026-05-27 *expressly because of the public-someday goal*. With that goal gone, alt-(c)'s sole objection ("exactly what a public app couldn't keep") no longer applies.
- **The PUBLIC/RESTRICTED scope-tier apparatus is deleted** from `oauth.ts` (`PUBLIC_FEATURES`, `RESTRICTED_FEATURES`, `PUBLIC_GOOGLE_SCOPES`, `RESTRICTED_SCOPES`, `isRestrictedFeature`, the module-load guardrail). `GOOGLE_FEATURE_SCOPES` + `scopesForFeatures()` + `requireScopes()` stay — per-feature resolution still drives targeted reconnects and per-tool capability gating.

**Amended scope set.**

| Surface | Scope | Tier (informational only now) |
| --- | --- | --- |
| Identity | `openid`, `userinfo.email` | profile |
| Gmail | `gmail.modify` + `gmail.send` | restricted + sensitive |
| Calendar | `calendar.events` (+ `calendar.readonly` via `briefing`) | sensitive |
| Drive | `https://www.googleapis.com/auth/drive` (full r/w) | restricted — **upgraded from `drive.file`/`drive.readonly`** |
| Docs / Sheets / Slides | `documents` / `spreadsheets` / `presentations` (full r/w) | sensitive |

**Still deliberately omitted:** `https://mail.google.com/` (full IMAP + permanent delete) — no tool needs it and it maximizes breach radius. Flip it only if a delete-mail tool is ever built.

**Resume framing (revised).** The original framing leaned on least-privilege + "public is a submission flip." The now-true narrative: *single-user personal assistant where the owner is the only principal — least-privilege across one's own data buys nothing, so I optimized for capability and documented the reversal in this ADR.* This is the open-item (d) below ("self-host-per-user / owner-is-developer") made concrete: in a single-owner deployment the OAuth developer **is** the data subject, which is exactly why no centralized verification regime applies.

**Operational steps (manual, owner).** In the GCP console add `gmail.modify`, full `drive`, and `documents` to the OAuth consent screen scope list (GCP will warn "requires verification" — save anyway; unverified-under-cap usage is unaffected). Confirm publishing status remains **In production**. Re-consent the owner account once to pick up the broadened grant.

**What's unchanged.** Multi-tenant *architecture* (per-user `integration_credentials`, `user_id` partitioning) stays — it costs nothing and keeps "go public" a non-rewrite if the never-public stance ever reverses. Production-unverified posture stays. The write *surface* is still gated by ADR-0043 (registry + `allowed_integrations` + action policy); broadening the OAuth grant unblocks write tools but does not register or auto-authorize any.

---

## ADR-0045 — Per-document ingestion cost guard: free pre-flight estimate, reject-on-exceed, passive row status

**Decision.** Every document the embedding pipeline touches gets a **free pre-flight cost estimate before any paid call**, and is rejected (not partially run, not retried into the ground) if the estimate exceeds a per-document budget. Two paths, one principle ("estimate, then approve or reject"):

1. **Embedding (new).** In `embedDocument()`, after chunking and before `embedMany()`, sum the chunk `tokenCount`s (already computed locally by the chunker — zero marginal cost), multiply by the Voyage input rate from `model_prices`, and compare to `ALFRED_EMBEDDING_PER_DOC_BUDGET_USD` (default **$1.00**). Over budget → skip the Voyage call, flip the document to `embedding_status='budget_exceeded'`, and stop. The estimate is exact for embedding because Voyage bills per input token and we know the token count before the call.
2. **Extraction (already shipped, ADR-0039).** The four-gate shield is the estimate-then-reject for the media path: the MIME allowlist, the 20 MB size cap, and the page-header read (no Claude call) are all free pre-flight checks; the 50-page cap bounds a single attachment at ~$1 of Haiku 4.5; the $5/day soft cap is the running aggregate. **No change** — ADR-0039 stands, and it already uses the cheap/fast model (Haiku 4.5 default, Sonnet only on a per-page figure-caption miss).

**Why this is its own ADR.** ADR-0015 metered every billable call but logs cost *post-hoc* — it never refuses one. ADR-0021 sized the embedding corpus at $3–9 *lifetime* and reasonably treated embedding as too cheap to gate. ADR-0039 built a cost shield, but only for the attachment-extraction queue. The gap this ADR closes: the **embedding path has no pre-flight refusal at all**, and `documents` has **no status column**, so a skipped or failed document is invisible. A reader will ask "embedding is nearly free — why gate it, and where does a rejected doc show up?"; this answers both.

**The per-doc embedding budget is a pathological-input ceiling, not an active throttle.** At `voyage-3.5` = **$0.06 / 1M input tokens**, the $1.00 cap is ~**16.7M tokens ≈ 67 MB of text in one document**. No real email, PDF, or note approaches it; the guard exists to stop a runaway input (a malformed export, a giant log dump, a base64 blob mistaken for prose) from silently embedding into a five-figure-chunk balloon. It rides for free on a token count the chunker already produces, so the cost of having it is one comparison. ADR-0021's $3–9 *lifetime* corpus estimate remains the accepted aggregate spend — **there is no lifetime cap enforced**; this ADR adds only the per-document ceiling.

**Schema (documents gains status; full DDL in migration).**

```
documents  (gains columns; existing rows default to 'pending' then backfill to 'embedded')
  embedding_status ('pending' | 'embedded' | 'budget_exceeded' | 'failed')  default 'pending'
  skipped_reason   ('budget_exceeded' | null)
  last_error       text nullable        -- populated on 'failed', mirrors ADR-0039's attachments.last_error
  estimated_embed_tokens integer nullable  -- the pre-flight number, for audit + UI
```

Mirrors ADR-0039's `attachments.extraction_status` shape deliberately, so the two ingestion families surface the same way. `chunks.embedding` stays nullable as today; the document-level status is the unit a human or agent reasons about.

**Surfacing — passive row + agent-visible flag, no notification.**

- **Passive row status.** `embedding_status` / `skipped_reason` live on the row, queryable by a future documents/library UI. The row IS the dead letter (same philosophy as ADR-0039's `extraction_status='failed'`); no separate table.
- **Agent-visible flag.** Retrieval surfaces a budget-skipped document to the boss agent so it can say "I have a document I haven't indexed (too large to embed)" inline, rather than the doc vanishing from recall with no explanation — the embedding-path twin of ADR-0039's `truncated_at_page` flag.
- **No active notification.** Deliberately excluded. A `notify()` kind for budget events is not built; at single-user scale a per-doc embedding rejection is a near-impossible event, and the passive status + agent flag cover the realistic case (the user asks about a doc, the agent explains it wasn't indexed). Revisit only if a second user or a routinely-firing cap makes silent skips a real support burden.

**Recovery.** A `budget_exceeded` document is not embedded but is not lost — the row and content persist. Raising `ALFRED_EMBEDDING_PER_DOC_BUDGET_USD` and re-running the embed sweep (`gmail.embed_sweep`, ADR-0037) re-evaluates it. No automatic retry: unlike a transient `failed`, a budget rejection is deterministic and will fail identically until the budget or the document changes, so the embed sweep skips `budget_exceeded` rows and only retries `failed` ones.

**Trade-offs accepted.**

- **A `budget_exceeded` doc is silently un-searchable** until a human raises the cap or the agent surfaces it on demand. Accepted: the alternative (notification spam for an event that essentially never fires) is worse.
- **The estimate trusts the chunker's char-based token count** (4 chars/token), which can drift from Voyage's real tokenizer. Accepted: the cap is a 67 MB sanity ceiling, not a fine-grained throttle, so a ±20% tokenizer error changes nothing material.

**Alternatives.**

- (a) **No embedding gate (status quo / ADR-0021's stance).** Rejected here only at the margin — embedding is genuinely cheap, but a free pre-flight guard against a pathological input is one comparison, and the user wants an explicit, documented ceiling.
- (b) **Lifetime or daily embedding budget.** Rejected — ADR-0021's $3–9 lifetime is acceptable spend; a daily/lifetime embedding cap is the "per-MIME budget split" ADR-0039 already rejected as premature. The per-doc ceiling is the proportionate guard.
- (c) **Per-doc dollar cap on extraction too.** Redundant — ADR-0039's 50-page cap already bounds one attachment at ~$1; a second dollar check on the same path adds nothing.
- (d) **Active `notify()` on every budget event.** Rejected — see Surfacing; near-zero fire rate doesn't justify a new notification kind.

**Open.**

- Whether the documents/library UI that renders `embedding_status` is built in this milestone or deferred — the schema lands now regardless so the status is recorded from day one.
- The exact env-var default ($1.00) — trivially tunable; promotes to `user_action_policies` only when a second user appears, same as ADR-0039's $5/day cap.

**Cross-ref.** Extends ADR-0015 (metering) from log-only to refuse-before-call on the embedding path; complements ADR-0039 (the extraction-path cost shield) with the matching embedding-path guard and a shared row-status surface; the budget number is a sibling of ADR-0039's `ALFRED_DOC_EXTRACTION_DAILY_BUDGET_USD`. Recovery rides ADR-0037's embed sweep.

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
- **Category-aware ingestion filter** — skipping `CATEGORY_PROMOTIONS`/`SOCIAL`/`FORUMS` at the realtime `persistMessage` gate would cut embedding + triage + attachment-extraction cost on the long tail. Deferred because Gmail categories are mutable: a message a user later moves from Social to Primary should pick up full processing, and at-ingest filtering loses that signal without a "category-change" reprocessor. Revisit when observed spend on PROMO/SOCIAL/FORUMS work materially exceeds tolerance, or as part of a broader "re-ingest on label change" path. Until then, all PRIMARY + non-PRIMARY mail flows through the same pipeline.

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

## ADR-0046 — Per-run cost ceiling for looping agent workflows (stub, deferred)

**Status.** Stub. Surfaced during m13 Phase 7 grilling as a sibling concern to ADR-0035; deferred from m13 so compaction can ship without entangling budget enforcement. Decide and implement post-m13.

**Decision (intended).** Introduce a per-run USD budget cap for any workflow whose run is driven by an LLM loop (today: `userAuthoredBriefWorkflow`'s boss-turn ↔ dispatch-tools ↔ compact-transcript triplet). When the running sum of `api_call_log.cost_usd` for a `run_id` crosses the cap, the executor fails the run with `error.message='cost_ceiling_exceeded'` before the next `boss-turn`. Default cap to be sized against observed real-world runs; v1 likely a static config knob (`ALFRED_PER_RUN_USD_CEILING`) before becoming a per-workflow column.

**Why this is its own ADR.**

- **Orthogonal to ADR-0035.** Compaction preserves *quality* by keeping the context window in the high-quality region. It does not bound *cost* — a runaway loop with cheap tool errors can compact happily and still rack up boss-turn calls. The 30-turn cap in `userAuthoredBriefWorkflow` is a structural ceiling but a coarse one (a single high-input turn can cost more than 30 small ones).
- **Orthogonal to ADR-0045.** ADR-0045 gates a *single document's* embedding cost; this gates a *single run's* total spend across LLM + tool calls.
- **Why not "in m13".** Designing the right surface (per-workflow override? user-level monthly cap? soft warn vs hard fail?) requires real run data Alfred doesn't have yet. Shipping compaction first lets us watch cost distributions accumulate in `api_call_log` and pick the threshold empirically rather than guess.

**Open questions to settle when this ADR lands.**

- Granularity: per-run only, or also per-workflow / per-user / monthly?
- Behavior on cross: hard-fail the run (current sketch) vs. interrupt for user approval to continue (HIL pattern) vs. soft-warn + log?
- Whether the cap reads from `model_prices` × estimated next-turn token count for *pre-flight* rejection (cheaper but inexact) or only post-hoc from `api_call_log` (exact but always burns the over-budget call).
- Whether to count compactor spend against the cap (compactor saves boss spend; double-counting punishes the right behavior).

**Cross-ref.** Sibling to ADR-0035 (quality). Builds on ADR-0015 (per-call cost log). Will likely interact with ADR-0034 if a "user approves continuing past budget" branch is added.

---

## Suggested implementation order

The decisions are now self-contained enough to start building. Proposed milestone order:

1. **Scaffold** ✅ _done 2026-04-27_ — copied milkpod's pnpm + Turborepo + packages (`ai`, `api`, `auth`, `config`, `db`, `env`, `sync`) + `apps/server` + new `apps/web` (Vite + TanStack Router). `@alfred/*` namespacing throughout. Acceptance criteria from `docs/plans/scaffolding-plan.md` all green.
2. **Auth + first Railway deploy** ✅ _done 2026-04-28_ — Better Auth with emailOTP + one-email allowlist (ADR-0009; passkey deferred per ADR-0009 implementation note). Railway project provisioned (Postgres + Redis + server + web), initial Drizzle migration generated and applied via preDeploy. `/health` 200 with `db: connected`; web SPA serves; Better Auth endpoints reachable. Sentry (server + web) and PostHog (web) wired and initializing from env vars. M2-only env-var coverage: all 11 required + Anthropic, Google, OpenAI, Resend, Perplexity, Sentry DSNs, PostHog key/host. Lessons captured in `docs/plans/scaffolding-plan.md` so M1 won't repeat the migration-not-generated and PORT-hardcoded bugs.
3. **Replicache MVP** ✅ _done 2026-04-28_ — `packages/sync` with `noteCreate` mutator + zod arg schemas; server-side push/pull/CVR/poke at `/api/replicache/*`; per-user Redis Pub/Sub poke channel + SSE; refcounted subscribe; multi-device sync verified.
4. **Realtime stack** ✅ _done 2026-04-29_ — `events_outbox` table + AFTER INSERT trigger firing `pg_notify('events_outbox_new')`; LISTEN/NOTIFY-driven relay (`packages/api/src/events/outbox-relay.ts`) with `FOR UPDATE SKIP LOCKED` drain, publish-then-mark for at-least-once delivery, 5s backstop poll, reconnect-on-end. Generic `/api/events` SSE with `Last-Event-ID` and `?since=` replay, watermark-and-buffer to prevent replay/live duplication. `publishEvent({ tx, userId, kind, payload })` validates against per-kind zod schemas at insert time. Replicache pokes intentionally kept on a separate, lower-latency direct-emit bus (ADR-0005 lists pokes as one event type but the contract — idempotent hints, not durable state — argues against forcing them through outbox). End-to-end verified in browser: live SSE, multi-tab fan-out, replay-after-disconnect.
5. **Durable agent runtime** ✅ _done 2026-04-30_ — `agent_runs` checkpoint table + step function + BullMQ worker (`packages/api/src/modules/agent/{executor,worker,queue,service,registry}.ts`); idempotent step pattern with `(run_id, step_id, attempt_id)` keys (ADR-0006 + ADR-0014). `echo-with-approval` builtin workflow + `smoke-agent` / `smoke-agent-resume` scripts cover the resume-from-checkpoint path.
6. **Cost metering** ✅ _done 2026-04-30_ — `metered()` helper + `metered.text/object/embed` wrappers in `packages/ai/src/metering/`, `api_call_log` + `model_prices` tables, `pnpm --filter @alfred/db db:sync-prices` script seeded from `models.dev` (ADR-0015). Langfuse trace export wired alongside (ADR-0023). `smoke-metered` / `smoke-metered-fail` cover happy-path + failure logging.
7. **First integration end-to-end (Gmail)** ✅ _done 2026-05-01_ — OAuth, ingestion job, live tools, webhook + polling, schema for `documents`/`chunks` with pgvector (ADRs 0010, 0024). Sub-tasks:
   - **7a** ✅ OAuth (gmail.readonly + send + modify scopes) + credentials table + `gmail.ingest_recent` BullMQ job that lists+fetches recent messages and writes raw `documents`.
   - **7b** ✅ Voyage embeddings + chunker (`packages/ingestion/{chunker,embed-document,search}.ts`) + `chunks` table with pgvector cosine + hybrid search helper.
   - **7c** ✅ Code complete: webhook (`/webhooks/gmail`) + `users.watch`/`users.history.list` bindings + `gmail.poll_history`/`watch_renew`/`poll_sweep`/`embed_sweep` jobs + 5min poll-fallback cron. Push-notification activation (Pub/Sub topic IAM, push subscription, watch install) since completed in production; the 5-minute polling fallback stays active as a safety net.
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
    - **Execution gap**: the planned failed-run stub was scoped out before ship; pre-m13 user-authored dispatches threw on registry miss before a run row was inserted. m13 replaces that gap with the sentinel workflow + real `AlfredAgent` loop.
13. **Boss + sub-agent orchestration** — fills m12's user-authored execution gap. Builds the tool registry + tool dispatcher + `system.load_integration` + `AlfredAgent`→runtime bridge + sub-agent spawning + `event`/`on_signal` dispatchers all in one pass (ADRs 0016, 0026, 0040). Lands HIL approval (ADR-0034) alongside — every tool call routes through the dispatcher, and gated calls park on `wakeCondition.kind='hil'` referencing an `action_stagings` row.
14. **MCP client** — connect external MCP servers, register their tools (ADR-0018).
15. **Observability polish** — review Sentry/PostHog/Langfuse instrumentation; add agent-trace UI surface in alfred itself (ADR-0023).

---

## ADR-0047 — Generic `event`-trigger dispatch: the `emitEvent` bus + triage unification

**Status.** Accepted (m13 Phase 8a).

**Decision.** Lift `event`-trigger dispatch from per-feature hardcoding to one generic bus:

1. **`emitEvent({ userId, source, type, eventId, payload })`** queries `workflows` for active rows matching `(trigger.kind='event', trigger.source, trigger.type)` and `createRun`s each with a uniform `input: { documentId, reason, source, type }` and `trigger: { kind:'event', source, type, eventId, payload: { documentId, reason } }`. Single dispatch path; called per freshly-inserted doc from the Gmail ingestion worker.
2. **Triage is unified onto the bus.** `enqueueTriageRuns`' hardcoded `createRun` against `TRIAGE_WORKFLOW_SLUG` is deleted. Triage's `workflows` row already carries `trigger.kind='event'` (was declared so the cron tick ignores it); the bus now matches it like any other event workflow. `email-triage`'s `initialState` still reads `input.documentId/reason` — run behavior byte-identical; only its dispatch moves from imperative to query-matched.
3. **`source`+`type` become closed const-narrowed enums** in `@alfred/contracts` (`EVENT_SOURCES`, per-source `*_EVENT_TYPES`), replacing the informal `source: 'gmail.ingest'` string. v1: `gmail.message_received`. The `webhook|ingest|manual` breadcrumb rides `trigger.payload.reason`, not the type. `trigger.filter` is retained on the schema for forward-compat but **not evaluated** in v1 (API rejects non-empty `filter` writes, like `steps`).
4. **Payload resolves at run-init into bounded context.** `trigger.payload = { documentId, reason }` (a light pointer + breadcrumb); the sentinel `userAuthoredBriefWorkflow`'s `initialTranscript` becomes async + DB-aware, reads the `documents` row using `userId + trigger.payload.documentId`, and appends a `user`-role `<trigger_event>` message after the brief. The message carries ids, source/type, title/subject, sender metadata, authored time, URL, and a raw content excerpt capped at **4,000 characters** for v1. Inbound third-party content is **not** blindly inlined in full; if the boss needs more, the auto-seeded source integration gives it the provider read tool (for Gmail, `gmail.read_message`, registered in Phase 8a). User-authored outbound content may be inlined in full when Alfred created it. No raw email bodies are persisted in `agent_runs.trigger.payload`. If the referenced document is missing/deleted, the transcript still starts and `<trigger_event unavailable="true">` records the pointer instead of failing run creation.
5. **Event runs auto-seed the trigger source's integration** into `state.activeIntegrations`, intersected with `workflows.allowed_integrations` (same cap rule as `@`-mentions), so a gmail-triggered workflow has gmail tools without a redundant `@gmail` in its brief.
6. **Idempotency is bounded, not global.** The worker fans out only freshly-inserted `documentIds` (insert-once → emit-once) behind the webhook handler's existing 30s TTL dedup, and `emitEvent` does a best-effort non-terminal duplicate check on `(userId, workflowSlug, source, type, eventId, reason)` before creating a run so an ingestion job retry does not normally double-fire. `eventId` is audit/filter only; no hard DB constraint.

**Why.**

- **One dispatch path.** ADR-0027 promised event triggers would "build the same `trigger` block and hand it to the same `createRun`." The bus delivers that literally — there is no longer a triage-shaped path beside a user-workflow-shaped path.
- **`trigger.payload` stays a pointer.** Inlining full email bodies into every fired run's `trigger` jsonb would duplicate content at rest (ADR-0038) N times on a fan-out and pull raw bodies into a column outside `SENSITIVE_LOG_PATHS` coverage. Resolve-at-init keeps the run's persisted trigger clean while still giving the boss enough context to decide whether to read more.
- **Boss stays tool-driven.** Auto-seeding the source integration and handing the boss bounded raw context (not pre-digested decisions) preserves ADR-0040's model: the boss reads and decides.
- **Inbound content is treated differently from Alfred-authored content.** A message from outside can be arbitrarily long, adversarial, or irrelevant; a bounded excerpt plus a registered read-tool escape hatch gives a good first turn without silently burning the context window. Content Alfred itself just generated is already in the run's trust boundary and can be inlined when useful.

**Alternatives rejected.**

- (a) **Additive sidecar** — keep `enqueueTriageRuns` imperative, add a parallel user-workflow query leg. Rejected: preserves the two paths the bus exists to collapse; any new event source would have to choose a path.
- (b) **`emitEvent` over Redis Pub/Sub** — rejected: an extra hop for no gain; the ingestion worker already runs in-process with `createRun`, and fan-out is a DB query any instance can do where the work already is.
- (c) **DB unique index on `(user_id, workflow_slug, eventId)`** — rejected: triage deliberately reuses `eventId=documentId` across `reason`s (a later reply-retriage of the same document), which the index would wrongly block. The real risk profile is *missed* fires, not duplicates.
- (d) **Live `filter` evaluation in v1** — rejected: an untestable matching mini-language; the brief-only boss already judges relevance from the bounded trigger context and can read more through the source tool when needed.
- (e) **`source`-only (no `type`)** — rejected: can't distinguish received-vs-sent mail; the existing `'gmail.ingest'` string already informally encoded a type.
- (f) **Inline full inbound content into `<trigger_event>`** — rejected: great for tiny emails, bad as a default. It makes the first boss turn hostage to unbounded third-party text and can crowd out the workflow brief, tool definitions, and user policy context before compaction has a chance to run.

**Implementation notes.**

- `WorkflowInput` widens to include `userId` and `trigger`; `Workflow.initialTranscript` becomes `MaybePromise<AgentTranscriptMessage[]>`; `createRun()` must `await` it before inserting `agent_runs.transcript`.
- Event trigger schemas change in both places: workflow triggers store `{ kind:'event', source, type, filter? }`; new run triggers store `{ kind:'event', source, type, eventId, payload }`. Historical event runs are already persisted as `{ kind:'event', eventId, payload }`, so `agentRunTriggerSchema` must either make `source/type` optional on read or a migration must backfill them. v1 preference: tolerant schema with optional `source/type`; new writes always include them.
- Phase 8a must register an executable `gmail.read_message` `liveTool` before relying on the bounded-excerpt fallback. `GMAIL_ACTIONS` already lists the action, but the registry is the source of truth for actual callability.
- Event trigger authoring is re-enabled in the workflow editor with `source/type` pickers and an empty-filter-only API contract. `on_signal` remains disabled.
- CRUD validation rejects an event workflow when `allowed_integrations` is non-empty and excludes the event `source`; otherwise auto-seed would expose no source tools and `system.load_integration` would also be capped out.
- Implement `emitEvent` under `packages/api/src/modules/workflows/` or `packages/api/src/modules/event-dispatch/`, not `modules/events/`, which already means the realtime outbox/SSE event bus.

**Caveat.** A core, smoke-tested pipeline (triage) now flows through new query/match code — `smoke-triage` and `smoke-boss` are the regression guards, and the migration must keep triage's `input` shape exact. The event duplicate check is intentionally best-effort and has a check-then-insert race; duplicate runs are less damaging than blocking a legitimate re-triage. **`on_signal` dispatch (Phase 8b) is deferred**: no code emits a named signal yet, so a subscriber would be untestable dead code. Revisit when a concrete signal producer lands.

**Cross-ref.** Extends ADR-0027 (trigger dispatch — `emitEvent` is its event leg), ADR-0040 (brief-only seed + sentinel `initialTranscript`), ADR-0034 (policy still gates the staged tool calls these runs make). Sibling Phase 8c decision: the per-integration policy editor syncs the `user_action_policies` row over Replicache (new `row_version` column) and dual-invalidates on mutation (`row_version` bump + `publishPolicyBust`) — recorded as an ADR-0034 amendment in `CONTEXT.md`.

**Amendment (2026-05-31) — `EVENT_SOURCES` is three sources, not gmail-only; an enum value may land one milestone ahead of its producer.**

The shipped `EVENT_SOURCES` (`packages/contracts/src/event-triggers.ts`) is `['gmail', 'google.oauth.callback', 'learn-skill']`, not the gmail-only set the main decision describes. Each carries a closed type: `gmail.message_received`, `google.oauth.callback.completed`, `learn-skill.completed`. The bus is the one generic `event`-trigger path for all three; the `webhook|ingest|manual` breadcrumb still rides `trigger.payload.reason`.

**This does not reopen the no-dead-paths rule that deferred `on_signal`.** That rule rejected building a *dispatcher subscriber* for a signal nobody emits — runnable code that can never be exercised. A `source` enum value is the opposite: a typed const with zero runtime behavior of its own. Declaring it ahead of its producer is cheap, reversible, and lets the producer land against a stable contract instead of editing the enum and the producer in lockstep. The honest line: **an enum value may precede its producer, but every declared source must have a producer committed in the same milestone** — no source ships purely speculative.

Producer status at amendment time:

- **`gmail.message_received`** — live. Gmail ingestion worker emits per freshly-inserted doc (`packages/api/src/modules/integrations/queue.ts:297`).
- **`google.oauth.callback.completed`** — live in source. Emitted on OAuth-grant completion (`packages/api/src/modules/integrations/google-routes.ts:325`) so post-connect workflows (e.g. cold-start enrichment after a new scope is granted) fire off the same bus.
- **`learn-skill.completed`** — producer in flight. The `learn-skill` workflow exists (`LEARN_SKILL_WORKFLOW_SLUG`) and already chains to `skill-documentation`; wiring its terminal step to `emitEvent('learn-skill', 'completed')` is the remaining work, replacing the current direct enqueue with a bus emit so skill-doc generation becomes a normal event consumer.

No schema or dispatch-path change — only the source/type tables widened. The duplicate-check, `<trigger_event>` resolve-at-init, auto-seed, and allowed-integration cap all apply uniformly across the three sources (a non-`gmail` source whose payload has no `documentId` simply yields a `<trigger_event unavailable>` and the run proceeds on its brief).

---

## ADR-0048 — Briefing v3: open-loop unit, discretionary morning + always-on evening, compose-time read-only reconciliation

**Decision.** The briefing is reframed at the product level. It is no longer "a cross-source digest composed and emailed every morning" (ADR-0041's empty-state-never-skips, single-surface model — itself the source of the "redundant, ugly, long" complaint that triggered this rethink). It becomes a set of **renders of an open-loop model**, split into two surfaces with **deliberately different firing models**. This **amends ADR-0041**: the gather/compose/reference/`briefings`-entity machinery is retained; the firing model, surface semantics, and framing are replaced. The current `morning-briefing` workflow (m10 deterministic inbox digest) is **replaced, not patched**.

Seven coordinated micro-decisions:

1. **The unit is the open loop.** Alfred tracks *open loops* — anything across integrations that needs the user or shapes their day. Briefings are **renders** of that model, not summarizers of inputs. The inbox is the "now" render; morning and evening briefings are two more. This is the framing that makes the rest cohere — "what to surface" is "which loops are live for this moment", not "summarize today's email".

2. **Triage labels are immutable; reconciliation is read-only and compose-time.** A thread tagged `action_needed` stays tagged — it was correct when written. The briefing cross-checks candidate loops against current integration state at compose time (a PR that merged silently → loop closed → don't surface) but **never rewrites the triage record**. Rewriting triage on integration state changes is a cross-source state-machine — a separate, deliberately-avoided "can of worms" (see Parked). Thread-cache invalidation on *new Gmail activity* is the existing, separate mechanism.

3. **Form: a <6-sentence paragraph.** Not a list, not a digest. Still-live/urgent items collapse to **one summary sentence**, omitted entirely when nothing is live (no "you have no urgent items" padding). Email stays short, ends in a `View full briefing` link. (This is tighter and more prescriptive than ADR-0041's 4–6-line `breakingSummary`, and the same content drives both surfaces.)

4. **Morning = orientation, discretionary.** Forward-facing ("what does my day look like"), **today + tomorrow** window, calendar-anchored. Folds in **recall** that is *anchored to a concrete calendar item* (no event → no recall — open-ended "surface relevant old context" is rejected as a noise source). Firing is **discretionary**: a routine day → **silent, no email**. But the gate **errs toward sending** on ambiguity because the costs are asymmetric — an unnecessary short email costs ten seconds; a wrongly-suppressed briefing costs the dropped ball. Mechanically this is **compose-then-gate**: draft, then decide if it clears the bar; a suppressed morning still leaves a quiet in-app record so suppression never reads as a bug.

5. **Evening = close, always fires.** Distinct job: close the day. Content = synthesis of what came in (**loops closed / still open — closure, not a transcript** of what the user already watched happen) + any meeting still left this evening + optional **tomorrow-prep** (surfaced at night while there's time to act) + a **human leaving note**. It **always fires** because closure is intrinsically valid, and content **degrades gracefully** to **weather + a personal sign-off** ("34°C in Delhi, clear sky. See you tomorrow, Yash") on an otherwise-empty day — the daily-varying weather is what keeps the note from becoming wallpaper. A **week-level** note ("brutal week — log off") rides along occasionally, keyed to real intensity, never nightly.

6. **Day-aware framing, localized.** Both surfaces read the *kind of day* (weekday / weekend / the user's holidays) before choosing words; holidays are localized via the onboarding profile (Thanksgiving ≠ India). ADR-0041 had day-of-week/holidays as a *gather source*; here it is also a **voice/framing** concern — a Sunday surfaces a live item rephrased for downtime, not narrated like a workday.

7. **Channel: email push + in-app durable record.** Email carries the paragraph + `View full briefing` link; the in-app surface is the canonical, scrollable record and the silent-day escape hatch. (Reaffirms ADR-0041's split surface and ADR-0020's email-only-at-v1; overrides ADR-0041's "empty state never skips, single daily send" with the morning/evening firing models above.)

**Schema consequence.** Two sends per day (morning + evening, distinct jobs) means the per-day identity from ADR-0041 (`UNIQUE(user_id, briefing_date)`) must gain a **slot** dimension — `(user_id, briefing_date, slot)` with `slot ∈ {morning, evening}`. The existing slot-based `briefing_runs` table (from the in-flight `daily-briefing` workflow) and ADR-0041's `briefings` table consolidate into one slotted entity — **resolved in the 2026-06-02 amendment below** (keep `briefings` canonical, add `slot`, retire `briefing_runs`).

**Why.** The original briefing was rejected as "redundant (I've already seen my priority email), ugly, and long" — a daily memo that re-narrated the inbox regardless of whether anything warranted it. The fix is not a nicer template; it is a different posture: **think like a personal assistant**, who speaks when it matters in the morning and closes the day with you in the evening. The open-loop framing is what lets "speak when it matters" be principled rather than ad hoc, and the read-only reconciliation is what makes "it matters" honest (a merged PR is not a live loop) without opening the much larger live-state-machine build.

**Alternatives.**

- (a) **Keep ADR-0041's unconditional daily single briefing.** Rejected — it *is* the complaint. A memo every morning regardless of content is the noise the rethink exists to remove.
- (b) **Rewrite triage tags when integration state changes** (true reconciliation). Rejected for this iteration — a cross-source state machine fed by webhooks is a real build and a "can of worms"; the label was correct at write time, and compose-time read-only filtering captures the user-visible value now.
- (c) **Recap-as-transcript / open-ended recall.** Rejected — telling the user what they already watched happen, or surfacing unanchored old context, reproduces the exact "I already know this" redundancy. Recap is closure-only; recall must anchor to a concrete calendar item.
- (d) **Warm sign-off every night as a standalone reason to send.** Rejected — a heartfelt note nightly becomes wallpaper within a week. Solved by making the *evening close* the job and degrading content to daily-varying weather rather than firing a content-free greeting.
- (e) **Always-send evening + always-send morning (symmetric).** Rejected — symmetric firing reintroduces over-pinging; morning's orientation job has nothing to say on a quiet day, evening's close job always does. The asymmetry is intentional.
- (f) **Build the advance-reminder / anomaly workflow now.** Deferred — see Parked.

**Parked (explicit non-goals this iteration).**

- **Advance reminders** — commitments with a future date-of-impact, surfaced N days out, off the morning/evening cadence. A separate workflow and discussion.
- **Anomaly detection** — "a meeting you agreed to that isn't on the calendar yet." Highest magic, highest annoyance risk (a wrong nag burns trust fast); deliberately deferred. Shares the noise failure mode that anchored-recall (decision #4) was designed to avoid.
- **Continuous open-loops state machine** — webhook-driven reconciliation so the inbox is correct *between* briefings, not just at compose time. The right end-state; today is compose-time, read-only only. **(GitHub slice un-parked for persisted `todos` — see ADR-0052. Polling, not yet webhooks; the briefing's ephemeral-loop reconciliation here is unchanged but inherits ADR-0052's signals.)**

**Open.**

- The **"worth sending" gate** for the discretionary morning — threshold definition and whether it's an LLM judgment or a heuristic over loop signals. Trust-critical: a wrong suppression is the expensive error. (Where the gate *lives* and what it *records* is resolved in the amendment below; the threshold *logic* stays open.)
- **Recall anchoring precision** — quality here is where the feature lives or dies in practice.
- **Week-intensity signal** source for the evening week-level note (activity volume, run cost, hours-in-app, …).

**Amendment (2026-06-02) — entity, scheduling, suppression, and source-availability locked.**

The four implementation questions left open above are decided. The product model is unchanged; these are the structural commitments that let the rebuild start.

**A. Entity: `briefings` stays canonical, gains `slot`, `briefing_runs` is retired.** The `briefings` table (ADR-0041, Replicache-synced, typed `gather`/`full_briefing`) is the single canonical entity — matches the cutover note already in `packages/db/src/schema/briefings.ts`. It gains a `slot text NOT NULL` (`'morning' | 'evening'`); the unique index changes `UNIQUE(user_id, briefing_date)` → `UNIQUE(user_id, briefing_date, slot)`; the Replicache key changes `briefing/{briefingDate}` → `briefing/{briefingDate}/{slot}` and the read schema adds `slot`. `briefing_runs`'s two live roles migrate: the **watermark** (`watermark_at`, the `documents.ingested_at` cut-off per `(user, slot)`) moves onto `briefings` as a column, queried over **terminal *consumed* states only — `status ∈ {sent, suppressed}`** — and the partial watermark index moves from the legacy `WHERE status = 'composed'` to `WHERE status IN ('sent', 'suppressed')`. `composed` is deliberately **excluded**: in this model it is an *intermediate* state (`composing → composed →` gate `→ sent | suppressed`, decision C), so a run that crashes after compose but before terminalizing must **not** advance the cutoff — that window's loops were never delivered, and consuming them would silently drop a briefing the user never received (the asymmetric "silence is the expensive error" rule applies to the watermark too). `failed` (a composed briefing whose send failed, ADR-0041) is excluded for the same reason — the next run re-reads that window so nothing is lost; a stuck-`composed` or `failed` row is reprocessed, never consumed. The **prior-body-as-prompt-context** role is already served by `briefings.breaking_summary` / `full_briefing` (the agent reads prior `briefings` rows), with a `body_markdown` column added only if the mailer render needs the markdown source. Run-level audit (tokens, `agent_run_id`, error) belongs to `agent_runs` — ADR-0041 alternative (f) already rejected render-history — so `briefings` keeps only a soft `agent_run_id` for traceability. `briefing_runs` is marked **legacy-only immediately** and dropped in a follow-up migration once the daily-briefing workflow stops writing it.

**B. Scheduling: `briefing.tick` fans out both slots with slot-scoped idempotency.** Preferences already carry both hours (`briefing.delivery_hour` = morning, `briefing.evening_hour` = evening; `resolveBriefingPreferences` returns both). The tick's per-user check (`packages/api/src/modules/briefing/queue.ts`) widens from `localHour === deliveryHour` to evaluating **both** hours and enqueuing a run **per matching slot**. `enqueueBriefingRun` takes `slot: 'morning' | 'evening'`; the workflow `input` carries `{ slot, briefingDate, reason }`. The idempotency key becomes **slot-scoped** — `briefing:{userId}:{briefingDate}:{slot}` — replacing the morning-`briefing:` / evening-`recap:` split; the `email_sends (user_id, idempotency_key)` unique index still backs no-double-send, now per slot. If a user misconfigures `delivery_hour === evening_hour`, both fire the same hour — harmless (distinct slot keys), worth a log warning.

**C. Suppressed morning is a persisted terminal state, not a synthesized UI empty-state.** `BriefingStatus` gains `suppressed`: `pending | gathering | composing | composed | sent | suppressed | failed`. Two columns are added: `send_decision text` (`'sent' | 'suppressed'`) and `gate_reason text` (why the gate decided as it did). Flow for morning: `composing → composed →` gate `→ sent` (`email_send_id` set) **or** `→ suppressed` (`email_send_id = NULL`, `gate_reason` set). The composed `breaking_summary` / `full_briefing` persist **either way**, so the in-app "quiet day" record renders from a real row rather than being faked client-side. `suppressed` applies to **morning only** — evening always fires (its job is closure; on an empty day it degrades to weather + sign-off, which is a `sent`, not a `suppressed`). The Replicache read schema adds `slot`, `status`, `send_decision` so the client can render a quiet morning distinctly from an absent one.

**D. Source-availability contract: closure requires positive evidence; absence never closes.** Compose-time reconciliation (decision #2) is **fail-safe toward surfacing**. A loop is suppressed-as-closed **only** on a *positive authoritative signal* (GitHub reports the PR merged; a Gmail thread shows a reply was sent). When the provider is unavailable — scope missing, integration not connected, API error, or the contribution is `null` — the loop **stays live and is surfaced**, optionally flagged "couldn't verify current state." The composer is **forbidden from inferring closure**: the gather computes loop status deterministically and the composer only renders it — it may never downgrade a live loop to closed on its own. Email-derived signals (`source='email_triage'`) may *open or sustain* a loop and may carry positive progress evidence, but their **absence never closes** one. This **corrects the stale line in `docs/reference/briefing.md`** that says scopes are unchanged from m10 and briefing reads local DB only: calendar anchoring adds the **existing `CALENDAR_READONLY_SCOPE` (`calendar.readonly`)** to `GOOGLE_FEATURE_SCOPES.briefing` (which today carries only `gmail.readonly`). This **deliberately reuses** the scope the `calendar` feature already grants — public/sensitive tier, free to verify, often already consented — rather than introducing the narrower `calendar.events.readonly` ADR-0041 named; that constant does not exist in `oauth.ts`, and a second, divergent calendar scope would add a consent line and break the app's single-calendar-read-scope convention for marginal least-privilege gain. If least-privilege ever justifies the narrower scope, that's a deliberate `oauth.ts` change, not a doc-vs-code drift. Reconciliation reads ingested integration state from local DB where Alfred ingests it, degrading to surface-as-live where it doesn't. Current implementation has best-effort calendar + weather gatherers and keeps `integration_activity: { items: [] }` until direct activity producers are wired.

## ADR-0049 — In-app briefing surface: paragraph-first day view, day-keyed routes, resolver relocated to `@alfred/contracts`

**Decision.** Build the in-app briefing surface ADR-0048 §decision-7 calls the "canonical, scrollable record" — the half of the split surface that exists in the data pipeline (the `briefings` entity is Replicache-synced via `ENTITY_FETCHERS.BRIEFING`; `IDB_KEY.BRIEFING` is wired) but has **no consuming route**. Two routes on the **App grammar** (every current real route's convention): `/briefings` (reverse-chronological timeline) + `/briefings/$date` (day detail). The page components live in `apps/web/src/routes/-preview-briefings/` and are re-exported by thin `briefings.tsx` / `briefings.$date.tsx` route files — the same pattern `workflows.$workflow.tsx` uses; "preview" is just where current page components live, not a throwaway mock. The component is wired to real Replicache data from the start (a `useBriefings()` prefix-scan + `useBriefing()` per-day hook pair mirroring `use-workflows.ts`); read-only, no client mutators (the workflow is the sole writer).

**Render posture (paragraph-first).** ADR-0048 reframed the briefing *form* to a "<6-sentence paragraph, not a list, not a digest," but the `full_briefing` the composer emits today is still ADR-0041's multi-section structure (`{ headline, sections[], sourcePanels?, auditSummary? }`). The surface reconciles the two by leading with `breaking_summary` (the paragraph — the canonical prose both surfaces share) and treating `sourcePanels` as collapsible supporting detail and `sections[]` as secondary — never the primary layout spine. This is correct against ADR-0048's posture *and* renders today's data, so it does not block on a compose reframe; when compose later tightens to the paragraph form, the surface needs no restructuring (sections shrinking just means less collapsible detail).

**Day-keyed, stacked slots.** A day has up to two `briefings` rows (`morning` / `evening`, ADR-0048 amendment A's `(user_id, briefing_date, slot)`). The detail page prefix-scans `IDB_KEY.BRIEFING({ id: \`${date}/\` })` (actual key prefix: `briefing/{date}/`) and renders morning **above** evening, both visible (not tabbed — a day's story reads orientation → close top-to-bottom, and tabbing a max-of-two set adds a control for nothing). Per slot: paragraph always expanded; `sourcePanels` and the `why` / `auditSummary` disclosures collapsed by default. URL is human and shareable (`/briefings/2026-06-03`); the per-slot Replicache key is an implementation detail the page resolves.

**No quiet-day mode.** A `suppressed` morning (ADR-0048 decision C) is rendered **identically to any other row** — its composed `full_briefing` is short because the day was quiet, so it *looks* quiet without special chrome. `suppressed` (= email never sent) is surfaced at most as a subtle "Not emailed" metadata line, never a distinct layout, gate-reason callout, or expand/collapse quiet state. Suppressed mornings appear in the timeline like any day. `compose_fallback` rows render indistinguishably (no "generated without AI" badge — diagnostics noise for the user). Non-terminal rows (`pending` / `composing` / `failed`) show a muted per-slot placeholder rather than a blank; an empty account shows a calm "first one arrives tomorrow" state.

**Reference resolution relocates to `@alfred/contracts`.** The composer emits opaque `[[<kind>:<id>]]` tokens (the **Briefing reference** glossary term); the web surface must resolve them into typed `<EntityChip>` segments but **cannot import `@alfred/api`** (`pnpm check:web-boundaries`). The resolver core is already pure — `resolveBriefingReferences`, `BriefingSegment`, `listBriefingReferenceOptions`, `referencesFromSections` import only from `@alfred/contracts`. Move them there, and export `parseBriefingReference` (or carry `referenceKind` on resolved segments) so `<EntityChip>` does not duplicate string parsing in `apps/web` (contracts already owns `BRIEFING_REFERENCE_KINDS`, the gather schema, and `BriefingSourcePanel`). Email's `renderBriefingEmailHtml` stays server-side but calls the relocated resolver. The web hook resolves the synced `breaking_summary` (and each section `body`) against the row's synced `gather` at render time; `sourcePanels` arrive pre-resolved server-side so they need no client work. **One resolution truth, two renderers, no persisted-segment denormalization, no schema change** (`gather` already syncs). The existing `packages/api/test/briefing/references.test.ts` coverage moves with the resolver (or is mirrored) under `@alfred/contracts`; API keeps only email-renderer tests.

**`<EntityChip>` contract.** One component, variant by `BriefingReferenceKind` (`activity` / `meeting` / `email`) for icon/treatment. The kind comes from the contracts resolver/parse helper, not local string splitting. Interactive iff the resolved segment carries an `href`, static label otherwise. v1 `href` reality from the resolver: **email** → `gmailThreadUrl(threadId)` (clickable when `threadId` present), **activity** → `item.url` (clickable when set), **meeting** → none, so meeting chips are always static. All links open external (Gmail / provider URL) in v1; linking chips into Alfred's own thread/activity views is deferred (and meeting chips becoming clickable would require the calendar gather to start carrying the event `htmlLink`).

**Entry points.** A **Briefings** `NavLink` in `app-sidebar.tsx` → `/briefings` (the durable home). The chat rail footer CTA (already driven by `useLatestBriefing` / `/api/me/briefings/latest`) deep-links to the latest day's detail → `/briefings/{date}`. Two read paths for two jobs — the CTA needs only the latest date for its label/link (react-query), the routes read full rows from Replicache — no conflict.

**List scope.** v1 reads only the Replicache 30-day window (≈60 rows at 2 slots/day), reverse-chronological, no pagination, with an honest "Showing the last 30 days" boundary affordance. The `/api/briefings/history?before=...` endpoint the **Full briefing** glossary term anticipates is **deferred** until there is a >30-day archive worth scrolling.

**Why.** The briefing pipeline composes and emails daily, but the in-app surface ADR-0048 designed as the canonical record — and the silent-day escape hatch for suppressed mornings — was never built, so a suppressed morning currently has no surface at all and a sent one is only ever seen in email. Paragraph-first keeps the surface aligned with ADR-0048's posture without waiting on a composer rewrite. Relocating the resolver is the one structurally-significant move: it grows `@alfred/contracts`'s public API but is the only boundary-clean way to share one resolution truth between the server email renderer and the client surface, and it avoids denormalizing rendering output into the persisted entity.

**Alternatives.**
- **Sectioned-digest-first layout** (sections[] as the primary spine). Rejected — builds straight into the list/digest form ADR-0048 explicitly killed, and would need a layout redo after the compose reframe.
- **Slot-keyed (`/briefings/$date/$slot`) or opaque-id (`/briefings/$id`) routes.** Rejected — two URLs per day with an awkward default, or unguessable/unshareable URLs, for no gain over a day prefix-scan.
- **Resolve server-side at persist, sync `segments[]` on the row.** Rejected — denormalizes a rendering concern into the persisted entity, bloats the synced payload, duplicates prose already synced, and needs re-resolution when gather changes.
- **Duplicate a client-side resolver in `apps/web`.** Rejected — drift between two resolvers is exactly what the opaque-token design exists to prevent.
- **Special quiet-day UI mode.** Rejected — the composed content already carries the quietness; chrome would re-introduce the "memo on a quiet day" feel ADR-0048 reacted to.

**Parked (explicit non-goals this iteration).** `/api/briefings/history` + paginated archive; chips linking into Alfred-native thread/activity views; clickable meeting chips (needs calendar `htmlLink` in gather); any client mutator on `briefings`.

**Open.** Exact source/kind iconography and the `sourcePanels` accordion visual grammar are settled at build time against `../-dimension-ai-web` (`components.md`) and the chat page's grammar — design detail, not an architectural decision.

---

## ADR-0050 — Todos: persisted open loops, hybrid-authored, one-table status model, passive v1

**Decision.** Add a **`todos`** entity: a user-managed list of commitments, surfaced in the right-hand quick rail, where items are either captured by the user or **proposed by Alfred** from across connected integrations. The framing claim that makes the rest cohere: a todo is the **first *persisted* materialization of the open-loop model** ADR-0048 deliberately kept ephemeral. ADR-0048 computes "open loops" on the fly at briefing compose-time, reconciles them read-only, and throws them away — explicitly *not* building a persistent cross-source store (its Parked "continuous open-loops state machine"). A todo is the user's opt-in to *persist* one such loop and track it to completion. This entity is therefore the natural future home of that parked machine, which is why its deferrals (below) are deliberate, not gaps. **v1 is passive**: Alfred authors and assists, but never executes.

**Entity & status model — one table, status-driven.** A single `todos` table, not a todo table plus a separate suggestions table. Status is `suggested | open | done | dismissed`:
- `suggested` — Alfred-proposed, not yet accepted; renders in the rail's *Suggestions* section. Authored only by Alfred (`created_by='agent'`).
- `open` — a live todo: a user's manual add, or a promoted suggestion. The `+` affordance flips `suggested → open` (a one-field update, no cross-table copy).
- `done` — completed; `completed_at` set. Done todos **linger 7 days** then fall out of the sync window, not the database (instant vanish loses the "I did this" beat and the list's honesty).
- `dismissed` — declined/dropped. On a `suggested` row it is a "no thanks" signal; on an `open` row it is "dropped it." Both terminal.

Deliberately **absent at v1**: `running` / `interrupted` / `needs_attention` / `error` — those are dimension's *agent-run* states, reserved for the deferred agent-executable path. Todos are a **flat open list**, not day-bucketed: the rail's date header is ambient context only. Columns: `id`, `user_id` (FK CASCADE), `name`, `description?`, `status`, `created_by` (`'user'|'agent'`, survives promotion so acceptance is measurable later), `executor` (`'user'` in passive v1; `'agent'` deferred), `kind` (`'task'` in v1; future executor-specific variants), `assist?`, `sources` (jsonb), `agent_run_id?` (FK, traceability), `completed_at?`, `position?` (forward-compat for manual reorder), `due_date?` (forward-compat, no scheduling built), `+ lifecycle_dates`, `row_version`.

**Authoring — `system.suggest_todo`, source-agnostic, no HIL.** Alfred's proposals enter through a single write tool, `system.suggest_todo`, callable by any agent run. It inserts a `suggested` row. It is **off the `action_stagings` / approvals HIL path** (ADR-0043): a suggestion has no real-world side effect, so gating it would be a category error. This is the explicit exception to the generic "state-changing system tools are staged for audit" runtime posture: audit lives on the todo row (`agent_run_id`, `created_by`, lifecycle dates), not in an approval record. The **primary caller is the briefing workflow** — it already runs a cross-source `gather` (email + calendar + `integration_activity`), so suggestions ride the existing cross-source open-loop computation rather than a second pipeline; triage and chat may also call it. The tool is **source-agnostic by construction**: cross-integration coverage falls out of the gather and widens automatically as `integration_activity` producers land (GitHub, then Slack once connected). User-authored todos and user-initiated lifecycle transitions (`create`/`complete`/`reopen`/`promote`/`dismiss`/`edit`) are **client Replicache mutators**; agent writes are server-side via the tool, then poke. The `assist` field carries an optional Alfred-authored tip on how to approach the item, degrading to an honest "I can't act on this — no permission / integration not connected" when Alfred is clueless. `assist` is *not* execution.

**Multi-source provenance — `sources` from day one.** Provenance is a `jsonb` array of typed refs `[{ provider, kind, id, url? }]`, not a single email-only `source_thread_id`. The canonical source identity is `(provider, kind, id)`; `url` is display/navigation metadata and does not participate in dedup. A todo represents a real-world commitment that can span channels (a Gmail thread *and* a Slack thread on one row), so it must carry N sources from the first write. This is also the data the deferred cross-source state machine would watch. The briefing's `[[<kind>:<id>]]` reference *resolver* is deliberately **not** reused: it resolves against a frozen `gather` snapshot, whereas a todo resolves against *live* data; same kind vocabulary, different resolution context, so fusing them now would be premature coupling.

**Dedup — owned by gather-normalization + a merge guard, structural only.** One real-world event must yield one suggestion even when it arrives through two channels (tagged in Slack *and* an email notification of that tag). Dedup lives in two places, neither of them the todo schema:
1. **Gather normalization** — a service-notification email (e.g. `notifications@slack.com`) normalizes into its origin-provider activity item via triage's existing `SenderContext` body-actor parsing + `integration_activity` email-triage backfill (`source='email_triage'`), so it never becomes a standalone email loop. When a direct producer exists, the direct event and the notification-email dedup by provider/thread id here.
2. **`suggest_todo` idempotency** — before inserting, the tool checks for an existing `open`/`suggested` todo referencing any incoming `source`; on overlap it **merges** (appends only missing source refs to that row's `sources`) instead of creating a duplicate.

This handles the **structural** case (the notification is recognizable and shares an id). **Semantic** dedup — two genuinely independent signals about the same ask with no shared id — is LLM-judgment over loop identity and is **deferred** with the rest of cross-source resolution; worst case the user gets two suggestions and dismisses one.

**Surface.** Right-hand quick rail (`quick-access-rail.tsx`), two sections mirroring `../-dimension-ai-web`: **Todo** (checkbox list of `open`/`done`) above **Suggestions** (`suggested` rows, each with a `+` to promote). Replicache-synced: `IDB_KEY.TODO`, per-row key `todo/{id}` (flat — no day prefix); `syncedTodoSchema = { id, status, createdBy, executor, kind, name, description?, assist?, sources, agentRunId?, completedAt?, position?, dueDate?, rowVersion }`; `ENTITY_FETCHERS.todo` filters `user_id = current AND status != 'dismissed' AND (status != 'done' OR completed_at >= now() - 7d)`. The screenshot's checkmark/camera toggle is the deferred agent-executable switch and is at most laid-out, not wired.

**Why.** "Action item extraction → managed todo list" was listed in the workflow catalog (this file, workflow-defaults table) as **OFF** at v1 — "partly redundant with the email-triage `action_needed` tag." That redundancy dissolves once you see a todo as a *persisted open loop* rather than an email-tag mirror: the `action_needed` label is an immutable triage fact about one thread; a todo is a cross-source, user-owned commitment the user manages to completion. Building it on one status-driven table (rather than dimension's two-entity suggestion/promote shape) matches Alfred's single-user scale and keeps provenance attached to one surviving row. Routing Alfred's proposals through a no-HIL `suggest_todo` tool — not the approvals path — keeps the heavyweight gate where it belongs (side-effecting writes) and lets the cheap, side-effect-free act of *suggesting* stay cheap. Keeping v1 passive avoids prematurely opening a second front door onto the boss runtime (manual-trigger workflows already are one) and avoids the parked cross-source state machine, while the forward-compat columns (`executor`, `kind`, `sources`, `due_date`, `position`) mean each deferred capability lands without a database migration.

**Alternatives.**
- **(a) Two entities (dimension's `suggestedMessages` + `todos` + `createFromSuggestion`).** Rejected — dimension needs the second table because suggestions there also back suggested *chat prompts*; Alfred has no such second consumer, so it buys only a join, a copy-on-promote, and a second synced entity. A `suggested` status is the same UX with one table.
- **(b) Agent-executable todos in v1** (mark `executor='agent'`, spawn an `agent_runs` run, reflect run-state on the checkbox, gate tool calls via `/approvals`). Deferred — strictly more powerful and clearly on the roadmap, but it inherits run-state, interrupt linkage, and a tool-scope model onto a checklist, and overlaps the existing manual-trigger workflow front door. Schema is shaped so it lands later without a database migration.
- **(c) Single email-only `source_thread_id`.** Rejected — a todo is a cross-channel commitment; an email-only link can't represent "opened from a Slack tag *and* an email" and would need a migration the moment Slack connects.
- **(d) Cross-source auto-close now** (watch every surface; close a todo when the user replies anywhere). Deferred — this *is* ADR-0048's parked "continuous open-loops state machine": live webhooks from every integration + identity resolution + completion signals. Also blocked on reality (Slack isn't connected). v1 completion is manual.
- **(e) Route suggestions through the `action_stagings` HIL.** Rejected — approvals exist for side-effecting writes; a suggestion has no side effect, so gating it is a category error and a heavyweight detour for a dismissable row.
- **(f) Reuse the briefing `[[<kind>:<id>]]` resolver for provenance.** Rejected for now — it resolves against a frozen gather snapshot; todos need live resolution. Shared kind vocabulary, not a shared resolver.
- **(g) Day-bucketed todos with rollover** (dimension's `assigned_date`). Rejected at v1 — brings a rollover job, overdue semantics, and the "unfinished todos vanish/pile up" annoyance for no v1 value; `due_date` lands forward-compat without scheduling.

**Parked (explicit non-goals this iteration).**
- **Agent-executable todos (the B-path)** — `executor='agent'`, runtime-backed, HIL-gated. The headline future capability; schema is forward-compatible for it.
- **Cross-source auto-close + cross-source identity resolution** — the ADR-0048 parked state machine; todos are its future home (the `sources` array is the watch-list).
- **Semantic dedup** of independent same-topic signals with no shared id.
- **Due-dates / scheduling / rollover** and the parked **advance-reminders** workflow (commitments surfaced N days out) — `due_date` column exists; the cadence logic does not.
- **Manual drag-reorder** — `position` column exists; the interaction does not.
- **Suggestion-acceptance learning** (tuning what Alfred proposes from accept/dismiss rates) — `created_by` + dismissed-state make it measurable later.

**Open.**
- **Suggestion production cadence** — primary caller is the briefing workflow (≈2×/day), but whether triage events should also fire `suggest_todo` live (event-driven freshness vs. proposal noise) is settled during build against observed rates, not now.
- **Exact rail visual grammar** — section treatment, suggested-row affordance, done-fade — settled at build time against `../-dimension-ai-web` and the existing `quick-access-rail.tsx`; design detail, not architectural.

**Amendment (2026-06-05) — producer model inverted: suggestions are real-time off triage, not a briefing ride-along; resolves the cadence Open.**

The original ADR named the **briefing workflow** the primary `suggest_todo` caller (reuse its cross-source `gather`, avoid a second pipeline) and left **production cadence** Open. Production exposed the failure mode: a new user (`yash.k@oliv.ai`) signed up, accrued **6 `action_needed` + 5 `urgent`** triaged threads within six hours, and got **zero** todos — the `morning-briefing`/`daily-briefing` cron never fired in that window, and nothing else calls the tool. The cron-batch producer makes the rail *hostage to a ~2×/day job*; for the surface whose entire value is a live, in-the-UI commitment list, that is the wrong cadence. **Decision: todos are produced by a real-time pipeline; the briefing is removed from the todo path entirely.**

- **Briefing is fully decoupled — not even a "mentioner."** It neither reads `todos` nor calls `suggest_todo`. Its action-ish mentions are **ephemeral open loops** (ADR-0048), computed from the gather/embeddings at compose-time and thrown away — a parallel feature that happens to look similar, not "todos that got mentioned." This reaffirms the CONTEXT.md boundary (ephemeral *open loop* vs. persisted *Todo*); the two never touch. Strike "primary caller is the briefing workflow" from the original Authoring section.
- **Producer = a tail step on the `email-triage` run.** "Real-time like email tags" means the tag *is* the trigger: triage already fires per freshly-ingested Gmail doc (`emitEvent`, ADR-0047), so the suggestion is minted in the same run that classifies the mail. The todo's `agent_run_id` points at that triage run — clean provenance, **no second pipeline, no extra run, no boss**. `suggest_todo` stays the **source-agnostic seam** (its original design), so each future real-time source calls it from *its own* ingestion path: email via triage now; `integration_activity` producers (GitHub first) from their ingestion as they land. There is **no standalone cross-source gather** for todos — the briefing owns the only daily gather, and todos ride per-source events instead.
- **Selectivity — the tag is necessary, not sufficient.** Two-stage gate: (1) deterministic category pre-filter drops `marketing`/`newsletter`/`fyi`/`done` outright; (2) a **context-sufficiency judgment** mints a suggestion only when the mail is worth acting on *and* carries enough concrete context to write a specific, actionable item. A vague ask ("something broke, please fix" with no what/where) yields **no todo even when tagged `action_needed`/`urgent`** — a bad, un-actionable rail item is worse than a missing one.
- **Where the judgment runs — folded into the single cheap classify call, zero added cost.** Consistent with ADR-0051 ("cheap-model-always, made smart by deterministic context; no routine boss"): the context-rich `classify` call already has the full email open, so its output schema gains one optional `todoSuggestion: { name, assist? } | null`. No new LLM call, no boss escalation (ADR-0051 removed it). The quality lever for the context-sufficiency call, if flash-lite under-judges, is ADR-0051's **conditional second cheap pass** / prompt iteration — **not** a boss step.
- **Unchanged.** One-table status model; no-HIL (a suggestion has no side effect); source-overlap **merge** as the v1 dedup guard (now more load-bearing — the same thread can surface in both a real-time triage event and, later, a cross-source activity event); 7-day done window; `executor`/`kind` inert. Noise is governed by the selectivity gate and tuned against observed accept/dismiss (`created_by` + `dismissed`), per the original noise rationale.

This **resolves the cadence Open** (real-time/event-driven, not cron-batch) and reverses the producer choice; it is a producer/trigger change only — **no schema migration** to `todos` (the `todoSuggestion` field lives on the triage classifier's output, not the DB).

**Amendment (2026-06-06) — todo-worthiness is an orthogonal rubric, not a category gate; floor shrunk to `{marketing, newsletter}`.**

The 2026-06-05 amendment's selectivity was a **two-stage category gate**: (1) a deterministic pre-filter dropping `marketing`/`newsletter`/`fyi`/`done`, and (2) a context-sufficiency check folded into the cheap classify call. Production showed this conflates two orthogonal axes. *Category* answers "what kind of mail is this / which Gmail label"; *todo-worthiness* answers "does this leave an obligation on the user worth remembering." Folding the second into the first produced **both** error directions: a self-initiated "Sign in to Anthropic" email (correctly `action_needed`) **minted a todo** because `action_needed` is eligible and the ask is concrete; and an `fyi` that carries a real obligation ("auto-renews unless you cancel") **could never** mint one because `fyi` was floored. The fix is not a sixth exemplar — it is to make the todo decision its own judgment.

**Decision: todo-worthiness is an orthogonal rubric the cheap model applies over the whole email, with category demoted to evidence + a thin consistency floor.**

- **The rubric — five ordered tests, stop at the first failure (prompt rule 16).** (a) **Obligation on me** (gate): is there an action the *user* must take? (b) **Significance**: does it matter on its face — a deadline, money, a deliverable, a commitment — vs. real-but-trivial (rate-your-driver, optional surveys)? (c) **Memorability**: would the user forget/drop it, or is it self-resolving / mid-flow (self-initiated auth, expiring codes, "thanks!")? (d) **Actionability**: can a specific item be written from the email alone? (e) **Already handled**: thread state shows the user replied / loop closed. Only all-five-pass yields a `todoSuggestion`. This is a **memory-aid** test, not an "is there an action" test — **memorability is the load-bearing discriminator**, and it dissolves the old rule-15 auth patch into a *consequence of principle* (auth fails the memorability test) rather than a hand-written exception.
- **Category and todo may legitimately disagree.** The decision evaluates the whole email including secondary/trailing asks; a `done` closure that ends with a significant request stays `done` AND can yield a todo. The category is never distorted to chase the ask.
- **The deterministic floor shrinks to `{marketing, newsletter}`** (`TODO_INELIGIBLE_CATEGORIES`, `resolveTodoSuggestion`) and is reframed as a **consistency guard against classifier leakage**, not a relevance judgment: a genuine personal obligation on a broadcast bucket is, by definition, a misclassification. `fyi` and `done` leave the floor — the rubric owns them.
- **Significance is split; personal relevance is deferred.** v1 judges **intrinsic** significance from the email alone — which already kills both live bug classes (auth via memorability, trivial-survey via significance). **Personal relevance** — "does this touch a project/person *this user* cares about" — needs the agent's persistent memory and is parked (D1 below).
- **Principles + log-sourced exemplars.** The rubric is the pillar; a small set of **exemplars** anchor it only at boundaries where two dimensions tug (each exemplar names its deciding dimension), harvested from `triage.sender_extraction` logs, never pre-guessed. This is the disciplined form of the example-patching that opened this work.
- **Observability — a rubric trace.** `todoDecision: { outcome, note? }` is emitted on **every** classification (`outcome ∈ {proposed, no_obligation, not_significant, would_not_forget, too_vague, already_handled}`), logged to `triage.sender_extraction`. A wrong suggestion *and* a wrong omission are now debuggable by dimension — so the rubric is **tuned**, not patched.
- **Unchanged.** Folded into the single cheap classify call, zero added LLM cost, no second pass, no boss (ADR-0051); one-table status model; no-HIL; source-overlap merge; manual completion. **No schema migration** — the rubric output rides the classifier; `todoDecision` is an additive field on its output, not a DB column.

**Auto-removal of suggestions — explicitly out of scope; v1 is manual dismissal.** The lifecycle counterpart ("when does a suggested todo stop being worth showing") is deferred to the existing `dismissed` status (user dismisses in the UI). Two parked forms: **same-thread retraction** (auto-dismiss an unpromoted suggestion when sent-mail thread state shows the user already replied — feasible on the foundation built, withheld until dismissal rates justify the tool-call spend) and **cross-source auto-close** (already parked, alt-d). Every retraction is a tool-call/DB mutation; spend them on evidence, not speculation.

**Parked threads surfaced during this grill (deliberate non-goals, recorded so they aren't gaps):**
- **D1 — Personal-relevance significance.** A cached, compact `User context` projection (role / company / active projects / key people) fed to the rubric's significance test. Gated on `entities` actually populating (0 on prod today) and a cold-start fact-quality check. The orphaned `readTriageUserContext` reader is the seed; "cache the projection" is real work (6 live queries, uncached).
- **D2 — User-fact expiration/decay.** Facts need a validity horizon so a stale role/project doesn't silently poison significance. Fact-layer concern (ADR-0012), but a prerequisite for D1 being trustworthy.
- **D3 — Self-evolving memory.** The broader system that learns the user from every chat/email/integration signal. Its own track; this ADR only *consumes* memory.
- **D4 — Agent-authored deterministic execution facets.** The escape from the N-tool-calls cost of bulk mutation: the agent authors a schema + handler once (approved), then steady-state runs without an LLM in the loop ("a machine that builds machines"). Cross-cutting agent-runtime direction, not todo-specific. See `oss/self-syncing-agent`.

**Amendment (2026-06-09) — stringency reframe: real-stake significance, manufactured-urgency exclusion, ownership-attribution gate, terse-imperative voice.** Production review of the live rail (37 agent-todos across two prod accounts; ~70% noise) exposed three failure classes the 2026-06-06 rubric did not catch, all rooted in a **too-loose significance test**, not bad bot-detection. The fix sharpens the rubric's text; it does **not** un-defer personal relevance (D1 stays parked).

- **16b significance is reframed from "matters on its face" to "real, external stake."** The old wording — "a deadline, money, a real deliverable, a commitment to a person, *or a clear cost of not doing it*" — let **manufactured urgency** clear the bar: a chess.com streak "lost at midnight," "7 unread on Linear," "5 people viewed your profile," marketing scarcity. The reframed stake is one of: *a real, identifiable person waiting on an action by the user* (identifiable from the email at v1; the org-graph enriches this under D1/B); *money owed or at risk, a hard deadline, lost access, a commitment made to a human*; **or** *a real-world consequence to the user judged from content* — which is exactly where a **bot** earns a todo (leaked key, prod down). Stakes a product **manufactures to drive engagement**, and **ceremonial obligations** (AGM/"save-the-date"), carry no stake → `not_significant`, fall back to `fyi`. This stays **intrinsic** (email-only judgment) and is written as a **B-ready seam**: when D1's user-context projection lands, it feeds 16b as one more observation, not a rewrite. Personalized relevance (B) is the agreed *destination*, not a rejected path.
- **16a gains an ownership-attribution gate** (the "Sakshi standup" bug: a `done` todo "Run the Engineering standup meeting" minted for the user when the body said *Sakshi* runs it — the model had the right owner in `assist` and still assigned it to the user). 16a now requires the action be owned by **the user, not a third party named in the body** → else `no_obligation`. This needs the one piece of identity the email-only classifier lacks: a **minimal identity signal** (user display name + account email), added as a deterministic observation (ADR-0051 amendment). This is the first surgical brick of D1/B, forward-compatible with the full user-context slice.
- **The bot carve-out is model-judged, not slug-floored.** Rejected: growing `BOT_SLUGS` or a deterministic `resolveTodoSuggestion` backstop keyed on `effectiveAuthor='bot'`. Per ADR-0051 §5's anti-brittleness stance, the cheap model judges bot-ness + consequence from subject/content; advisory automated output (Greptile/CodeRabbit nitpicks, Dependabot) → `fyi`/no-todo unless the body carries a hard consequence. `effectiveAuthor` stays a fed *hint*, never a floor. **Liveness layer (the refinement the first dry-run forced):** for code/PR/review findings — bot OR human — the consequence test turns on *is something ALREADY LIVE at stake*: a secret already committed/exposed, a vulnerability in `main`, a prod outage, a blocked deploy → real stake → todo; a finding that exists only in the UNMERGED PR (nitpick, perf, even a vuln in proposed code not yet in `main`) is pre-merge advisory → `fyi`. The discriminator is liveness, not "is a reviewer waiting" — this is what the dry-run showed prompt-only was missing (Greptile leaked 3/4 as "reviewer waiting" before the layer). No hard guarantee — validated by the dry-run backfill, tuned from `todoDecision` traces.
- **Title voice: terse imperative, active, name the object.** `name` is a short imperative (target ≤~8 words) with the real verb (`Reply`, `Pay`, `Fix`, `Rotate`), never a hedge ("Review and address…", "Look into…"). `assist` only when it carries a decision or concrete next step, active voice, else omitted. Schema cap (`name` ≤120) unchanged; the lever is the prompt.
- **Trace decision:** reuse the existing `not_significant` outcome with a light `note` convention (`manufactured:`/`advisory:`) rather than adding a `todoDecision.outcome` value — manufactured-stake *is* a significance failure; smaller blast radius, still log-aggregable.
- **Validation before any write: a dry-run backfill.** Re-classify historical email with the new prompt, **read-only**, and diff against current state in three buckets — *kills* (suggested todos the new bar drops), *category flips* (→fyi), and *false negatives* (real obligations wrongly dropped, the risk bucket). Ship the live prompt + a real re-tag/re-suggest backfill only after the diff clears.

---

## ADR-0051 — Email triage v3: cheap-model-always, made smart by deterministic context (sender priors + account persona + observation/inconsistency layer); supersedes ADR-0042's classifier shape

**Decision.** Triage keeps the cheap, fast model ([`getCheapModel`](packages/ai/src/provider.ts), gemini-2.5-flash-lite) on **every** email — speed and per-email cost are hard product constraints at real inbox volume. Intelligence comes not from a bigger model but from **deterministic context fed into the cheap model**: a per-sender category histogram (`sender_priors`), an account persona label (work/personal), thread state (sent-mail aware), a known-contact flag, Gmail-native signals, and cheap regex content flags. A deterministic **observation/inconsistency layer** focuses the model's attention on anomalies; a **conditional second cheap pass** re-runs the model with a detected conflict spelled out; a **small high-precision override floor** can force `urgent`/`action_needed` on unambiguous severity signals. There is **no routine boss/Sonnet escalation** — the expensive, slow agent boss is at most a vanishing edge case, ideally absent. This inverts and supersedes [ADR-0042](#adr-0042): v2 was *cheap-classify-email-only + boss-deepen-on-a-gate*; v3 is *cheap-classify-context-rich-always, no routine boss*. The latency complaint that triggered this was a delivery bug (missing Gmail watch on connect, [ADR-0037](#adr-0037)), not the model — so v3 is purely an intelligence play that keeps latency low by construction.

Eight coordinated micro-decisions:

1. **Cheap model on every email; never skip the model.** The prior cache is a **fed signal, not a bypass**. A 99%-newsletter sender can still send one genuinely urgent message; always-classifying catches the anomaly while staying consistent on the routine. Because the model runs every time, the prior histogram is refreshed every time — there is no staleness problem and no cache-invalidation problem to solve.
2. **`sender_priors` as a fed histogram.** New table keyed `(user_id, sender_key)` where `sender_key` is the **exact lowercased sender address** or `service:<botSlug>` for recognized bots. Stores a raw category histogram (`category_counts`), not a verdict. **No domain-level priors in v1** (domain is where multi-type senders collide). **Human senders (`effectiveAuthor: 'person'`) are not cached** — a person's category is a property of each message, not the sender; the prior cache is explicitly a **bulk-sender** signal (newsletter/marketing/payment/digest/bot). The model reads the raw histogram and decides; there is **no `confidence`/`locked`/`source`/dominant-share gating** (those were artifacts of the rejected bypass design).
3. **Account persona is a per-credential context label.** Single-user, multi-account: a user may connect a work Workspace account and a personal one. Detect persona from the Google **`hd` (hosted-domain)** claim — Workspace domain → `work`, absent → `personal` — store it on `integration_credentials`, allow user override on the integration detail page, and feed a one-line label into the model's context. The **rich persona *policy*** (what is work-urgent vs personal-urgent) is **deferred to its own ADR**; v1 gives the model the label + a short guidance line and lets it reason with existing `user context`.
4. **Observation/inconsistency layer (the "make a cheap model smart" mechanism).** Two passes. **(a) Pre-model observations**, computed deterministically and always fed into the single cheap call: prior histogram, persona, thread state, known-contact flag, Gmail-native signals (`CATEGORY_*`, `IMPORTANT`, `STARRED`), and cheap regex content flags (unsubscribe footer / currency amount / security keywords / calendar invite). **(b) Conditional second cheap pass**, only on a hard, deterministically-detected conflict between the model's output and a strong expectation (prior / content flag / Gmail signal) — re-runs flash-lite with the inconsistency spelled out. Most inconsistencies are *prevented* by (a); (b) is a thin net, still sub-second, still cheap, **no boss**.
5. **Deterministic override floor.** A **small, high-precision** set of unambiguous severity signals (exposed credential/secret, CVE, payment-failure-breaks-access-today) may **force** `urgent`/`action_needed` regardless of model output; the **model owns the category everywhere else**. The set is seeded small and grows only from observed-data evidence (mirrors ADR-0042's bot-allowlist philosophy) — explicitly **not** a large keyword ruleset, to avoid re-introducing the brittleness that mis-tagged self-initiated sign-in links as `urgent` (the bug that opened this work).
6. **No correction loop in v1.** Do **not** extend the Gmail history sweep to reconcile user label-moves; do not build label-change attribution (its "did Alfred or the user move this?" ambiguity is a self-poisoning risk). Priors learn **only from Alfred's own classifications**. User corrections, if ever, arrive through **chat** ("that wasn't urgent") and are **deferred** to a later iteration; the schema reserves no machinery for it in v1.
7. **Sent-mail ingestion as a shared foundation.** Ingest `in:sent` via the existing `persistMessage` path **and embed it** — triage needs only thread state, but the user wants **chat recall over sent mail** ("did I send so-and-so a doc about X?"), which needs vectors, and it feeds future style profiles ([ADR-0013](#adr-0013)). Two hard guardrails: sent mail is **never triaged/labeled** (excluded from the triage event fan-out) and **never becomes a sender prior** (you are not a sender to cache).
8. **Thread state is a fed observation, not a hard rule.** Sent-mail awareness lets us tell the model "you last replied in this thread on `<date>`" rather than deterministically forcing `done`/`fyi`. The model owns the resulting category, dissolving the taxonomy-edge question of how "you already replied" maps onto the 10 buckets.

**Pipeline.**

```
ingest doc (gmail.poll_recent / gmail.poll_history)   [+ in:sent ingested, never triaged]
  ↓
extract-sender-context           deterministic, ~5ms (UNCHANGED — ADR-0042 #1)
  ↓
gather observations              deterministic, ~ms — prior histogram, persona,
                                 thread state, known-contact, Gmail signals, content flags
  ↓
classify (cheap, context-rich)   gemini-2.5-flash-lite, ~sub-second, ALWAYS
  ↓
[inconsistency check]            deterministic; on hard conflict → one more cheap pass
[override floor]                 deterministic; forces urgent/action_needed on the
                                 high-precision severity set only
  ↓
persist email_triage + update sender_priors histogram
  ↓
apply-label                      Gmail messages.modify + sibling strip (UNCHANGED)
```

**`sender_priors` shape.**

```ts
sender_priors (
  user_id         text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  sender_key      text NOT NULL,        // exact lowercased email | service:<botSlug>
  category_counts jsonb NOT NULL DEFAULT '{}',  // histogram, e.g. { newsletter: 12, marketing: 1 }
  last_category   text,
  display_name    text,
  last_seen_at    timestamptz,
  ...lifecycle_dates,
  PRIMARY KEY (user_id, sender_key)
)
```

**What this keeps from ADR-0042.** The deterministic `extract-sender-context` step (#1) and its `SenderContext` shape; the async dossier trigger + `person_profiles` cache (#4/#5) as a future hook; the `system.read_user_context` surface + `alfred:user-context:{userId}:v1` Redis read-through (#6) — though triage now reads that slice deterministically and hands it to the model as text rather than via a tool; and the `triage.sender_extraction` observability event (#7), extended with the new observations.

**What this supersedes in ADR-0042.** #2 (cheap classifier is email-only, no bio/profile — now context-rich; alt (g) is **adopted**, not rejected); #3 (the boss `deepen` step as a brief-only `AlfredAgent` loop on a confidence/bot/contact gate — there is no routine boss step and no agent loop in triage v3).

**Cost & latency (100 emails/day single user).** Steady state ≈ 100 cheap calls/day + a small fraction of second cheap passes ≈ **~$0.01–0.02/day** — same order as ADR-0042's cheap path, *minus* the ~10%/day boss-deepen line, because there is no routine boss. Latency: one cheap call (~sub-second), a rare second cheap call on conflict (still sub-second total); end-to-end user-perceived latency is dominated by realtime delivery (watch → pub/sub → poll_recent, ~sub-30s post-ADR-0037), not classification. The <10s goal holds by construction.

**Alternatives.**

- **(a) Cache as a model *bypass*** (deterministic resolver chain; skip the model on a confident prior). Rejected — a confident `newsletter` prior would blind triage to the one urgent message that sender ever sends. "Never skip the model" catches the anomaly; the prior is a hint, not a verdict.
- **(b) Smart model (Sonnet-class) on every email, no cheap tier.** Rejected — slower and materially more expensive per email; unsustainable at real inbox volume for a per-message job. The needed smartness is concentrated in edge cases, deliverable via context rather than a bigger model on the 95% obvious path.
- **(c) Cheap-always + elevate-to-boss on the cheap model's judgment** ([ADR-0042](#adr-0042)'s shape, kept). Rejected — leans on the cheap model to know when it is out of its depth (the exact judgment cheap models are weakest at) and pays slow/expensive boss latency on the most frequent *important* category (fresh human mail). Deterministic inconsistency-flagging + a focused second cheap pass gets the edge-case win without the slow tier.
- **(d) Gmail-label correction loop** (learn from user label-moves; lock priors). Rejected for v1 — history label events don't say *who* moved the label, so attribution risks learning from Alfred's own writes and locking a sender wrong forever. Deferred to a chat-driven correction path.
- **(e) Domain-level priors.** Rejected for v1 — domain is exactly where multi-type senders (`@bank.com` sends statements, fraud alerts, and marketing) defeat a single category. Exact-sender (role address) priors are far more stable.
- **(f) Human-sender priors.** Rejected — a person's category is per-message; a person→category prior would actively mis-tag. Humans are reasoned per-message with a known-contact flag from `entities`.
- **(g) Skip embedding sent mail** (thin thread-state-only ingestion). Rejected — the user wants semantic chat recall over sent mail, which needs vectors; full ingest + embed also serves style profiles.
- **(h) Confidence/locked/source gating on priors.** Rejected — those existed to gate a bypass; with the model always running, the raw histogram fed to the model is sufficient and simpler.

**Deferred (own discussions / future ADRs).**

- **Persona policy** — the rich definition of work-urgent vs personal-urgent relevance. Its own ADR; v1 ships only the persona label + plumbing.
- **Chat-driven correction** — a chat tool by which the user corrects a tag and pins a prior.
- **Connect-time prior backfill** — pre-warming priors by classifying recent mail at connect. A nice-to-have now that cold start is not a correctness problem.

**Open.**

- **Inconsistency-conflict definition** — the exact deterministic conditions that trigger the second cheap pass (prior-vs-output, content-flag-vs-output, signal-vs-output). Seeded conservative; tuned from `triage.sender_extraction` logs, not specified up front.
- **Override-floor membership** — the precise high-precision severity set. Starts minimal; grows only on observed evidence.
- **Second-pass rate** — if the conditional second cheap pass fires on too large a fraction of mail, the conflict conditions are too loose and get tightened before they cost real latency.

**Amendment (2026-06-05) — Phase 3 build resolutions: the Open section settled, Phases 3+4 collapsed.**

Building the context-rich classifier (plan Phase 3) forced the three Open items to concrete seeds and surfaced one supersession the original ADR left implicit. Grilled and locked 2026-06-05; folded into `CONTEXT.md` (*Triage override floor*, *Observation/inconsistency layer*, *Content flags (triage)*, *Known-contact flag*).

1. **The conditional second cheap pass replaces the boss `deepen` step — so plan Phases 3 and 4 are one change, not two.** The two are not independent: running both means the boss `deepen` and the second cheap pass both escalate on the same severity-suspect-bot edge case, which contradicts this ADR's "no routine boss." The classifier rewrite therefore lands together with the removal of the `deepen` branch from the triage workflow. The dormant `dossierRequest` hook and the `system.read_user_context` surface survive for non-triage/future use (unchanged from the body).

2. **Override-floor membership — seeded to ONE signal.** A secret/API key/token/private key/password exposed, leaked, committed, compromised, found, or detected (in either noun→verb or verb→noun order) forces `urgent`. Generic `credential` is deliberately excluded from the unrecoverable floor and remains only in the broader security content flag. **CVE-id presence and payment-failure-breaks-access are deliberately NOT in the floor** — both go to the model. A bare `cve-\d{4}-\d+` match forcing `urgent` would override rule 12a and re-introduce the Dependabot/advisory-bot noise the taxonomy tags `fyi`; "breaks access today" is a semantic call the model makes from the body. Critically, the floor predicate keys on *exposure verbs*, NOT auth vocabulary — it is strictly narrower than the `hasSecurityKeyword` content flag — so self-initiated sign-in/magic links (the bug that opened this work) never trip it.

3. **Inconsistency-conflict definition — two tightly-gated nets, max one re-run.** Of the three axes the body named, the prior-vs-important-output direction (anomaly catch) and the Gmail-signal-vs-output axis are NOT seeded — the always-on model fed the observations already covers the anomaly case, and a bigger model isn't what's missing. The pure `detectConflict` fires only on: **(a) under-classification** — `hasSecurityKeyword` is set, the model chose a passive category (`fyi`/`done`/`newsletter`/`marketing`), and the override floor did not already fire (the dangerous miss the floor doesn't cover); **(b) over-classification** — the model chose `urgent`/`action_needed`, the sender's prior is strong-bulk (total ≥ 5 and bulk-share ≥ 0.8), and nothing supports the severity (no security flag, not Gmail `IMPORTANT`) — the promotional-urgency over-reaction. The second pass re-runs flash-lite once with the conflict spelled out; its output is final (no third pass). Cost is a non-issue at ~100 emails/day; "conservative" here is about flip-flop churn, tuned from `triage.sender_extraction` logs.

4. **The `applyTriageClassificationGuardrails` rewrites are deleted — regexes demoted to named content flags.** Per §5's anti-brittleness stance, no deterministic post-model category rewrite survives. The review-bot rewrite is dropped outright (covered by the `service:<botSlug>` prior histogram, which converges to `{fyi: N}`, plus the override floor for genuine severity). The investor/AGM and public-event detection regexes survive **as named `ContentFlags` (`hasInvestorNotice`, `hasPublicEventLanguage`) fed to the prompt** — the model decides; the flags never rewrite. The `extract-sender-context` step and `SenderContext` shape are unchanged.

5. **`classifyEmail` owns the full sequence and returns an audit object.** `classifyEmail(args + observations)` runs first pass → `detectConflict` → conditional second pass → `applyOverrideFloor` internally and returns `{ classification, model, audit }` (audit: `firstPass`, `conflict`, `secondPass`, `secondPassFailure`, `floorMatched`, `floorForced`, observation summary) for the `triage.sender_extraction` log. `detectConflict` and `applyOverrideFloor` are pure exported functions, unit-tested directly; the second-pass loop takes an injectable model-runner seam so "at most one second pass" is testable without a live LLM. The workflow assembles observations (the IO: `getSenderPrior`, `getThreadState`, persona via an extended `loadTriageContext`, and a new best-effort `isKnownContact` for human senders only), calls classify once, persists, logs the audit, applies the label.

**Amendment (2026-06-09) — minimal identity observation + manufactured-urgency category principle (companion to the ADR-0050 stringency reframe).** Two classifier-side changes ride the todo-rubric stringency work:

6. **A minimal identity observation joins the deterministic context.** The cheap classifier was identity-blind about the *user* (it has the known-contact flag for *senders*, persona, priors — but not "who am I"). The todo ownership-attribution gate (ADR-0050 16a) needs exactly one thing: the user's **display name + account email**, rendered as one prompt line (`You are: <name> <email>`). Sourced from `user.name` (Better Auth) + the per-credential account email already used for persona — no new IO, no new table. This is the smallest possible step toward D1's full `User context` projection and is deliberately *just* identity, not role/projects/relationships (those stay parked under D1). It honors the §5 anti-brittleness line: a single deterministic fact fed as a hint, not a rewrite.

7. **The real-stake / manufactured-urgency principle is not todo-only — it reinforces the *category* side too.** A ceremonial obligation (AGM/shareholder "meeting," "save-the-date" gala) and an engagement nudge carry no real stake for the user → `fyi`, never `meeting`/`action_needed`/`urgent` unless they impose a concrete action + deadline on the user. This generalizes the existing rule 8 (public events) and rule 9 (investor/AGM notices) under one principle rather than adding more keyword rules — same anti-brittleness stance. The cheap model applies it from content; the `hasPublicEventLanguage`/`hasInvestorNotice` flags remain hints, never rewrites.

Both are validated by the same **dry-run backfill** (ADR-0050 amendment): read-only re-classification of historical email, diffed before any live prompt swap or re-tag/re-suggest write.

**Amendment (2026-06-10) — self-initiated auth mail demoted `action_needed` → `fyi` (rule 15).**

Self-initiated authentication mail — sign-in/magic links, one-time login codes, and email-verification the user *just requested* — was classified `action_needed` (the v3 resting place after rule 15 demoted it from the pre-v3 `urgent` floor bug). Production showed that was still the wrong home. The rubric contradicted itself: rule 16c already calls this exact class "self-resolving / nothing to remember" (→ no todo), yet the category put it in `action_needed`, the bucket the user scans for *real* tasks. The user initiated the flow and is already mid-flow; the link expires harmlessly and the action is moot by the time triage runs and reconciles the Gmail label. So it is passive awareness — `fyi` — not an open action. Rule 15, its category-definition lines, and the worked examples now say `fyi`; rule 16c (no todo) is unchanged.

This **supersedes the "(correctly `action_needed`)" characterization** of the "Sign in to Anthropic" example in ADR-0050's 2026-06-08 todo amendment — that example's *todo* verdict (no todo, via memorability) still holds and still illustrates category-vs-todo orthogonality; only its category label changes to `fyi`.

**Safety rests on §3's under-classification net, not on the category alone.** `fyi` is a passive category, so a security-keyword body filed there now trips `detectConflict`'s under-classification net (§3a) → one second pass with the self-initiated-auth carve-out spelled out. A genuinely *unsolicited* security alert mis-judged as auth therefore can't silently rot in `fyi` — it gets re-checked, and unsolicited alerts still resolve to `urgent` (rule 15's reserve clause, unchanged). Bare "sign in"/"login" don't match `hasSecurityKeyword` (it keys on secret-nouns / `suspicious|unauthorized` prefixes), so clean magic links stay single-pass. No change to `detectConflict` or the override floor — the net firing here is the intended context re-check, not a regression.

**Amendment (2026-06-13) — "task created" is not closure + thread state carries recent-message *content*.** A real prod miss (ClickUp thread, 2026-06-12): dvd assigned the user a bug ("please make sure this is fixed"), then asked ClickUp's "Brain" AI to file a task; Brain's reply "**Done.** Created [task] in the Backlog" was the latest message in the thread, so the per-thread overwrite stamped the whole thread `done` @ 0.9. Two compounding errors, two fixes — both keep the §5 anti-brittleness stance (principle in the prompt, not a keyword rewrite; a fed observation, model owns the category):

8. **Filing a task OPENS a loop; it is never `done`.** The `done` definition, rule 5 (closure), and rule 12e (activity-feed) now state that a task/ticket being *created / filed / opened / logged / added to a backlog* — including an automation reporting "Done. Created …" — is the START of work, routed by ownership (assigned/@-mentioned the user → `action_needed`; direct unanswered question → `awaiting_reply`; pure activity on someone else's item → `fyi`), **never** `done`. Closure means the user's underlying request is resolved, not that an intermediate actor finished a sub-step.

9. **`ThreadState` is extended from dates to recent-message content (the structural fix).** ADR-0051 #8 fed only thread *dates* ("you last replied on `<date>`"), so a trailing low-signal message was classified blind to an earlier open ask in the *same* thread — and per-thread overwrite (the deliberate, kept "re-evaluate on reply" contract) let that trailing message bury the live action item. `getThreadState` now also returns the most recent prior messages as bounded body excerpts (`recentMessages`: ≤6, header-stripped, ≤220 chars each, newest-first), rendered into the Observations block. New rule 17 tells the model the thread carries ONE tag and to judge the LIVE loop, not the last keystroke: a bot's "done" must not overwrite an earlier unanswered assignment/question. Still a fed hint — the model owns the category (consistent with #8's "thread state is an observation, not a hard rule"). With no earlier ask in the thread, a lone "task created" line lands `fyi`, never `done`. Validated by `apps/server/src/scripts/smoke-triage-clickup.ts` (the real miss + a no-context guard counter-case).

---

## ADR-0052 — GitHub loop reconciliation: API-native produce + reconcile of persisted todos, polling v1, GitHub App webhooks deferred

**Decision.** Un-park the GitHub slice of ADR-0048-D's "continuous open-loops state machine." A GitHub poller **produces** and **reconciles** persisted `todos` (ADR-0050) directly from the authenticated GitHub API — no email-derived identity. v1 polls; real-time webhooks via a GitHub App are the deferred upgrade. Scope is **persisted todos only**; the ephemeral briefing-loop reconciliation of ADR-0048 is untouched and inherits these signals for free.

**Important framing.** OAuth's `repo` scope already grants read across all the user's repos — sufficient to reconcile by *polling* today. It does **not** grant clean org-wide *push*; that is the GitHub App (ADR-0024). So produce and reconcile are the *same plumbing* once reconcile reads GitHub directly — **"reconcile-only" is not a coherent v1**, because the only way a todo acquires GitHub identity is GitHub producing it. (A literal reconcile-only would have forced the brittle email-PR-URL-parse path back in just to have something to match — rejected, alt-a.)

**Architectural shape.**

- **Two-tier poll.** `GET /notifications` (the structured mirror of GitHub's notification emails) detects + produces across *all* object types — `PullRequest`, `Issue`, `RepositoryVulnerabilityAlert` (Dependabot), `CheckSuite` (CI), `Discussion`, `Release` — each carrying `reason`, `subject.type`, `subject.title`, native identity. Per-object state endpoints (`/pulls/{n}`, `/issues/{n}`, `/dependabot/alerts/{n}`) provide the **authoritative** close signal. Closure requires a *positive* terminal signal (ADR-0048-D); absence — rate-limit, missing scope, API error — **never closes** (loop stays live).
- **Worthiness gate (deterministic, no LLM).** Produce on `review_requested | assign | security_alert`. On `author | mention`, a bounded **tier-2 state check** produces only if *changes-requested / required-check-failing / unresolved-review-threads > 0* (this is the bucket that catches "address the review comments on PR #N"). Drop `subscribed | comment | ci_activity | manual | state_change` — these still feed *reconcile*. GitHub's structured `reason` is what lets the gate be rules-over-data, not an LLM rubric (contrast email triage v3, ADR-0051).
- **Title (cheap LLM, gated).** Gate-surviving items get a cheap-model-authored title trimmed to read like a todo. The LLM fires **only post-gate** — never per-notification — so cost is bounded to actionable items. `subject.title` is the input anchor.
- **Lifecycle.** Produce `suggested`. **Auto-`dismissed`** for an un-promoted suggestion whose object goes terminal (low stakes — never on the committed list). **Auto-`done`** for a promoted (`open`) todo (higher stakes) — surfaced in the **evening briefing's "loops closed" recap** (ADR-0048 #5), never silent. `done` lingers 7 days, re-openable via the existing status mutator. The risk asymmetry is the whole point: dismissing an unaccepted suggestion is near-free; completing an accepted todo must be visible.
- **Dedup / suppression.** `system.suggest_todo`'s source-ref dedup handles re-polls (same `(github, <type>, <id>)` ref merges, never duplicates). Cross-surface duplicates are prevented by **verified-sender suppression**: a **DKIM/SPF/DMARC-verified `github.com` notification**, when GitHub is connected, makes triage **skip the todo-worthiness step** (the poller owns that loop). **Fail-safe toward surfacing** — uncertain verification falls through to normal triage; a wrongly-suppressed email drops a real todo (unrecoverable) while a wrongly-surfaced one is one dismiss to fix. GitHub not connected → triage unchanged.
- **Storage.** Poll cursor reuses `ingestion_state` (`stream='github_notifications'`; `Last-Modified` / `since` / `X-Poll-Interval` in `state`, typed + zod-parsed). New `todos.closed_by` (`'user' | 'reconciler'`) + `closed_reason` (`pr_merged | pr_closed | issue_closed | alert_dismissed | alert_fixed | review_threads_resolved`) columns, `.$type<>()`-guarded (matching `sources: .$type<TodoSource[]>()`). This single field powers **audit + evening-recap + the auto-dismiss client animation** (reconciler-closed rows linger briefly in the Replicache pull window — today `dismissed` isn't synced, so the row would otherwise blink out; Replicache ships the diff, the client reads `closed_by='reconciler'` and animates). `webhook_events` (ADR-0024) deferred to the App migration, where `provider_event_id` dedup earns its keep. New `@alfred/contracts` types mirror the GitHub API (`GithubNotificationReason`, `GithubSubjectType`, `GithubNotificationsCursor`, `TodoClosedReason`) and are zod-validated at the fetch boundary (`.$type<>()` is compile-time only).
- **Cadence + scope.** One ~10-min BullMQ repeatable job honoring `X-Poll-Interval` (min ~60s); each tick produces (new notifications) + reconciles (`suggested|open` todos with a github source ref). Scopes add `notifications` (+ `security_events` for Dependabot detail) — one-click re-consent.

**Why.** The pain — suggestions that stay live after the PR merged — is unsolvable while identity is email-derived (PR-only, brittle, spoofable). GitHub's authenticated API gives native identity across every object type, the deterministic gate keeps it inference-free except for titling, and positive-signal-only closure honors ADR-0048-D's trust contract. Polling on the existing `repo` scope ships it with no migration.

**Alternatives.** (a) **Email-derived reconcile** (append a parsed `github:pull_request` source to email-born todos) — rejected: PR-only (misses issues/Dependabot/CI/mentions), brittle, spoofable, and a dead-end the API obsoletes. (b) **Literal reconcile-only v1** — rejected: incoherent under API-native identity (nothing to reconcile). (c) **Deterministic `subject.title` titles, no LLM** — rejected by user preference: a cheap model buys real "reads-like-a-todo" quality at gated, bounded cost. (d) **GitHub App webhooks at v1** — deferred: polling needs no migration; the App is purely the latency upgrade.

**Parked / committed end-state.**

- **(B) Integration-as-producer, generalized beyond GitHub** — the committed direction. Integrations whose email notifications are blocked/absent must still surface loops directly; the binding constraint is **cross-surface dedup convergence** (the same object seen via two surfaces resolves to one todo). GitHub is the first instance.
- **GitHub App webhooks (real-time)** — replaces polling. Acceptance criterion: **one-click connect, zero post-auth setup** (the install flow's repo selection is GitHub-hosted, nothing configured in Alfred).
- **LLM title enrichment tuning** — refined from real data, the way the email worthiness rubric is tuned from `triage.sender_extraction` logs rather than example-patched.

**Open.**

- The **lingering window** length for reconciler-closed suggestions in the Replicache pull (long enough to animate on next tab visit, short enough not to clutter).
- Whether the **tier-2 state check** batches (GraphQL) or fans out REST calls under the per-tick rate budget.

**Amendment (2026-06-08) — GitHub App migration + activity webhooks shipped (un-defers alt-d).**

The deferred GitHub App is now the live credential model, reversing this ADR's "polling needs no migration, defer the App" stance for the *connection + activity* layer. Classic OAuth App is removed entirely.

- **Credential model.** Connect is now a GitHub App *install* (`https://github.com/apps/<slug>/installations/new`), registered with `request_oauth_on_install` so install + user authorization happen on one GitHub-hosted screen — satisfying the parked "one-click connect, zero post-auth setup" criterion. REST runs on short-lived **installation tokens** (App JWT via `jose` RS256 → `/app/installations/{id}/access_tokens`, cached in-process); the stored user-to-server token is identity only. `integration_credentials` gains an indexed `installation_id`; `search_pull_requests` now resolves an installation token. **Migration cost:** the single user re-installs once (legacy rows have no `installation_id`).
- **Activity webhooks (un-defers alt-d for ingestion).** `POST /webhooks/github` verifies `X-Hub-Signature-256` over the raw body, then persists `pull_request` / `push` / `issues` / `pull_request_review` deliveries into the new **`webhook_events`** table — the table this ADR said would "earn its keep" at the App migration. Idempotency is `on conflict do nothing` over `(provider, provider_event_id=X-GitHub-Delivery)`, the replay-safe story from ADR-0024/0014. Recent events feed the briefing's previously-empty `integration_activity` contributor (ADR-0041).
- **Registration.** One-time via the **GitHub App Manifest flow** (manifest POST → GitHub-generated app id / private key / client secret / webhook secret in a single conversion), driven through the browser. App "Alfred 99Yash", read-only `metadata`/`pull_requests`/`issues`/`contents`.
- **Delivery is prod-only.** The App's hook URL is the Railway server domain (`https://api.alfred.beauty/webhooks/github`); localhost can't receive deliveries. The user-OAuth callback keeps a `localhost:3001` entry so connect/identity is still testable locally.
- **Still future (not this amendment).** Replacing the ADR-0052 `/notifications` *poll* with webhook-driven todo produce/reconcile — the todos reconciler still polls. This amendment delivers the App credential model + activity ingestion + briefing surface; folding webhooks into the produce/reconcile loop is the next step.

---

## ADR-0053 — Deterministic connected tool declaration + dispatch-enforced gates; supersedes the prompt-only load instruction of ADR-0026/0040

**Decision.** The agent no longer relies on the model *inferring* when, and which, integration to load. The prompt-only instruction ([ADR-0040](#adr-0040) #6, mirrored in the chat preamble) is the bug: the boss is blind when an integration is inactive, so it can emit a bare action such as `list_events`, receive "Tool 'list_events' is not declared", and then ask the user to load Calendar. Observed in chat `454bad3d`.

The v1 fix is deliberately simpler than the original lazy-loading design:

1. **Declare connected ∩ allowed tools eagerly at run start.** The current real surface is small and code-controlled (Gmail, Calendar, Drive, Docs, Sheets, Slides, GitHub; Slack/Linear/iMessage are empty stubs). Declaring those full schemas gives the model the argument contracts immediately and removes the mid-conversation load round trip.
2. **Keep a connected summary in the system preamble.** A frozen, one-line-per-integration summary (`slug — actions — short desc`, with health markers) remains useful grounding and exact-slug copy, but it is no longer the only way the boss learns tools exist.
3. **Make the dispatcher the security floor.** `dispatchToolCall` must resolve bare/qualified names and hard-enforce `allowed_integrations` + scope-aware connection health before any registered non-system tool can execute. This closes ADR-0043's exposure-only hole: qualified calls cannot bypass the declared-tool surface.

Lazy catalog + `system.load_integration` + dispatcher auto-activation is deferred. It is a future optimization only if the connected schema surface becomes materially large; v1 should not pre-pay that complexity while N is small.

**Micro-decisions.**

1. **Eager connected declaration.** At run start, compute usable integrations as connected ∩ allowed ∩ non-empty-action slugs. Seed `agent_runs.state.activeIntegrations` with that set, and let the existing `resolveSdkTools` path declare their full schemas every turn. Empty `allowed_integrations` means unrestricted among connected loadable integrations; non-empty remains a hard cap. The old strict `@`-mention seed remains historical ADR context and can become a future hint for lazy mode, but it is not the v1 declaration boundary.

2. **Connected summary is frozen grounding copy.** Snapshot a short connected summary into run state at creation. The `AlfredAgent` `system` resolver may concatenate that frozen string with `BOSS_SYSTEM_PROMPT`, `CHAT_SYSTEM_PROMPT`, or `SUB_AGENT_SYSTEM_PROMPT`, but it must not perform live DB/health reads during a turn. This is cache-stable by construction; the old strict-pin runtime check is not a cross-turn backstop because agents are rebuilt per step.

3. **Scope-aware health is first-class.** `integrationHealth(userId, slug)` is not just `integrationCredentials.status`. For Google-backed slugs it must also check the scopes required by that slug (`gmail`, `calendar`, `drive`, `docs`, `sheets`, `slides`). A Calendar-only Google credential makes Calendar usable but does not make Sheets usable. With multiple Google rows, reduce to: any active row with required scopes wins; otherwise a relevant but unhealthy/insufficient row reports `needs_reauth`; otherwise `needs_connect`. Treat any non-`active` row status as unusable.

4. **Dispatch name resolution happens before the `isToolName` guard.** Bare actions such as `list_events` resolve to a qualified `ToolName` before `getTool`. Ambiguous actions such as `batch_update` return a structured `ambiguous_tool` result rather than guessing. The resolver should distinguish three outcomes: unknown, qualified, ambiguous.

5. **Dispatch hard gate.** For every resolved non-system integration: first enforce `allowedIntegrations` (`not_allowed`), then scope-aware health (`needs_connect` / `needs_reauth`), then the existing schema parse, policy resolution, staging, and execute path. Gated results must use the same actionable envelope shape as existing tool failures: `{ status, message, integration?, candidates? }`, so both chat and workflow bosses can relay useful text.

6. **No v1 auto-activate path.** Because usable connected ∩ allowed integrations are declared from run start, there is no inactive-but-executable happy path to recover. This avoids adding `activate` metadata to `DispatchResult`, avoids transcript/staging disagreement between bare and resolved names, and avoids classifying recovered calls as failures.

7. **`system.load_integration` becomes compatibility/deferred surface.** It may remain registered for old prompts and future lazy mode, but v1 should not depend on it for normal tool visibility. If it is kept, it must call the same `integrationHealth` helper and return structured `needs_connect` / `needs_reauth` failures instead of `{ ok: true }` on a connected-but-wrong-scope Google credential.

8. **User action policy remains orthogonal.** Auto-declared write tools still flow through `resolvePolicyMode` and staging. Eager declaration is not eager execution; `autonomy | gated` remains the write safety layer.

**Dispatch floor (pseudocode).**

```
resolution = resolveToolName(args.toolName, { allowedIntegrations })
if resolution.kind == 'unknown':
  return { kind: 'unknown_tool', result: { status: 'unknown_tool', message: ... } }
if resolution.kind == 'ambiguous':
  return { kind: 'ambiguous_tool', result: { status: 'ambiguous_tool', message: ..., candidates } }

name = resolution.toolName
intg = integrationFromToolName(name)
if intg != 'system':
  if allowed.length && !allowed.includes(intg):
    return { kind: 'not_allowed', result: { status: 'not_allowed', message: ... } }
  health = integrationHealth(userId, intg)
  if health.status != 'active':
    return { kind: health.status, result: { status: health.status, message: health.message } }

// existing getTool(name) / safeParse / policy / staging / execute path
```

**What this amends.**

- **ADR-0026 / ADR-0040 #4 & #6** — strict `@`-mention lazy loading is superseded for v1. Tool declaration is now deterministic from connected ∩ allowed credentials at run start, while prompts stop asking the model to infer load steps.
- **ADR-0043** — the "active exposure bounded by `allowed_integrations`" layer becomes dispatch-enforced rather than exposure-only.

**Alternatives.**

- (a) **Lazy catalog + two-step `load_integration` + dispatcher auto-activate.** Rejected for v1 after measuring the current surface: the schema cost is small, Gemini currently ignores explicit `cacheControl`, and the auto-activate path adds state/result/transcript complexity for little benefit. Keep it as the future relaxation if integration count or schema size grows.
- (b) **One-step universal `system.call_tool(name, input)` meta-tool.** Rejected. It removes normal JSON-schema tool declarations, making argument formation worse for complex tools.
- (c) **Cheap-classifier pre-seed.** Rejected as a primary trigger. A model call is not a deterministic loading boundary.
- (d) **Prompt-only plus `system.list_integrations`.** Rejected. It is the old probabilistic design with an extra discovery turn.

**Deferred.**

- **Lazy mode** once real schema volume justifies it. If revived, it must preserve the dispatch gate, scope-aware health helper, structured result envelopes, and resolved-name audit consistency described here.
- **Per-tool (L3) trust** (`IntegrationRule.toolOverrides`) — still orthogonal to loading.
- **Mid-run catalog freshness** — connecting or revoking an integration mid-conversation refreshes on the next run unless this proves painful.

**Open.**

- **Catalog description source** — hand-authored one-liners vs. reusing each tool group's existing description. Use short per-integration blurbs and skip empty-action stubs.
- **Ambiguity tie-breaks** — v1 can return `ambiguous_tool`; smarter tie-breaks can come later if ambiguous bares become common.
- **Audit artifact for blocked calls** — dispatch gates currently short-circuit before staging. Decide during implementation whether `not_allowed` / `needs_connect` / `needs_reauth` should create an audit row, or whether transcript tool results are enough.

## ADR-0054 — Meeting prep: persisted per-occurrence packet (recompute-in-place) + calendar-watch-driven proactive trigger (horizon + sweep)

**Decision.** Meeting prep (MEET-001) is built as a fourth member of the briefing family, not a bespoke pipeline. A deterministic **gather** assembles one calendar event's context (attendees, recent Gmail threads, memory facts, overlapping todos); a **boss-tier compose** turns it into a short cited note; the result is **persisted** to a new `meeting_preps` table, **Replicache-synced read-only**, keyed per calendar occurrence. The packet is produced proactively by a **calendar push channel + a near-term sweep**, and on demand by a `system.prepare_meeting` tool — all three triggers converge on the same entry point. **Delivery** (the pre-meeting email, web augmentation at send) is explicitly deferred to MEET-002; this ADR is the **packet + its trigger**, not the surface it's delivered through.

Build sequence and file-level detail live in [docs/plans/meeting-prep-v1.md](./docs/plans/meeting-prep-v1.md); glossary terms (*Meeting prep packet*, *`meeting_preps`*, *Gated recompute*, *Prep horizon + sweep*, *Calendar watch*, *`system.prepare_meeting`*, *Prep reference*) in [CONTEXT.md](./CONTEXT.md). This ADR records the hard-to-reverse choices and the reasoning a future reader would otherwise ask "why?" about.

**Micro-decisions.**

1. **Mirror the briefing pipeline, don't invent one.** `gather → compose → store → sync` with the same shapes: a deterministic structured gather (audit/replay in a `gather` jsonb column), a single `meteredGenerateObject` compose emitting `[[<kind>:<id>]]` placeholders over an `availableReferences` list, a status-machine row, and a per-surface reference resolver. Meeting prep is the briefing's per-event sibling; reusing the pattern is cheaper to build and to reason about than a parallel design.

2. **`meeting_preps`, keyed `(user_id, event_key)`, upsert/recompute-in-place.** `event_key = ${credentialId}:${googleEventId}`. With `singleEvents=true` the Calendar read expands recurring series to per-occurrence instance ids, so one prep per occurrence falls out naturally. Re-running `prepareMeeting` overwrites `gather`/`note`, bumps `row_version`, updates `computed_at`. Cancelled/deleted occurrences mark the row `cancelled` (terminal, excluded from active sync) rather than pretending the compose failed or hard-deleting audit. **No version history** — drift-tracking is not a demo need and a versioned table adds a "which row is current" read concern. Schema + the `event_key` wire shape are the hard-to-reverse bits this ADR fixes.

3. **Gated recompute via `material_hash` (deterministic, no LLM).** Meetings mutate before they happen; most mutations (a time shift) don't change the prep's content. A `material_hash` over attendees + agenda/description + location + attachments is the discriminator: no row → full gather+compose; material change → recompute; **time-only shift → cheap path** (update `event_start`, skip compose); unchanged → no-op. This is what reconciles "boss-tier compose" with "minimise costs" — the lever is the **number** of composes (gated + horizon-bounded), not the model tier. The tier choice is deliberate: prep is a demo centerpiece where synthesis quality matters, and gating keeps the frequency low enough to afford boss-tier.

4. **Email threads from the ingested `documents` corpus, not live Gmail.** A deterministic scan over `documents (source='gmail')` within a recency window, matching attendee emails against `metadata.{from,to,cc}`, grouped by `source_thread_id`, citing the newest message as `email:<documentId>` — uniform with the briefing's citation kind. Chosen over live Gmail (no extra round trips/scope, citable, testable) and over semantic chunk search (the spec is "threads *involving attendees*," and the MEET-001 acceptance demands **deterministic** unit tests around attendee matching + source selection). `memory_chunks` vector recall is added as an **additive enrichment** for the memory-facts slot only, kept out of the deterministic units so the acceptance still holds for what it names.

5. **A parallel reference contract, not an extension of the briefing enum.** `MEETING_PREP_REFERENCE_KINDS = [meeting, email, todo]` + `resolveMeetingPrepReferences` in `@alfred/contracts`, mirroring the briefing resolver (relocated there per ADR-0049) but expanding against the *prep* gather. Briefing's tested enum/resolver stay untouched; each surface resolves against its own gather shape. Rejected: extending `BRIEFING_REFERENCE_KINDS` (pollutes it with a kind briefings never emit and couples one resolver to two gather shapes) and a generic shared resolver (largest refactor, touches the working briefing path — wrong risk profile for June). **Memory facts are not a citation kind** in v1 — they have no navigation target, so they're woven into prose with their ids retained in the gather for a future SEARCH-001 evidence layer.

6. **Proactive trigger = calendar push + near-term sweep, dispatched through `emitEvent`.** This is an application of [ADR-0024](#adr-0024) (change notifications) and [ADR-0047](#adr-0047) (event-trigger dispatch). The **surprising-without-context** part worth recording: Google Calendar push (`events.watch`) is **HTTPS-callback** based (not Pub/Sub like Gmail's `users.watch`), and pushes fire on **change, not on time passing** — an event booked weeks out pings once at creation and never again as it approaches. So neither a pure webhook nor "prep at scheduling" is sufficient: prep **compose** fires only for qualifying events entering a **48h horizon**, a push handles near-term changes immediately, and a **~20-min sweep** catches events that cross into the horizon without ever changing. The push handler `emitEvent`s `calendar.event_scheduled`; an event-triggered job calls `system.prepare_meeting`.

7. **No event mirror — `syncToken` cursor in `integration_credentials.metadata.calendarWatch`.** Mirrors the Gmail watch's `metadata.watch` convention (one watch per credential, v1 = `primary` calendar only). The push handler acts on the `events.list(syncToken)` delta live; the sweep does a bounded live `events.list(now, now+48h)`; the prep gather reads the event live and snapshots it into `gather`. Reuses the existing live calendar read path (consistent with how briefings read calendar today). A `documents`-backed calendar mirror (CAL-002) can land later without reworking this — chosen to keep the June surface small and dodge embeddings/reconciliation scope.

8. **`system.prepare_meeting` is the single convergence point.** A `system.*` tool (autonomy by default, riskTier `no_risk`), input `{ eventKey } | { timeMin, timeMax, attendeeHint? }`. The boss calls it on a chat request; the push job and the sweep call the same tool. **Event qualification** applies only to window-resolution (timed, `attendees ≥ 2`, not declined — skips focus blocks); an explicit `eventKey` is prepped unconditionally (explicit user intent wins). No internal-vs-external attendee filter in v1 (a MEET-002 prioritization concern).

**What this builds on.**

- **ADR-0041 / ADR-0049** — the gather/compose/store/sync pipeline and the contracts-resident reference resolver that meeting prep mirrors.
- **ADR-0024** — the change-notification posture; calendar watch is its second concrete application after Gmail.
- **ADR-0047** — the `emitEvent` bus the proactive trigger dispatches through.
- **ADR-0050** — `todos.sources` is the overlap key for the todo slot.
- **ADR-0053** — `system.prepare_meeting` rides the dispatch floor + autonomy posture like other system tools.

**Alternatives.**

- (a) **Cheap-tier (flash) compose**, matching triage. Rejected for v1: prep is the demo centerpiece where synthesis quality is the product, and gated-recompute + the 48h horizon already hold compose frequency low enough to afford boss-tier. Revisit if frequency or cost data says otherwise.
- (b) **Compute-on-demand, no table.** Rejected: no in-app surface, no delivery substrate for MEET-002, and recompute cost on every view. The synced packet is the artifact.
- (c) **Fold calendar-watch into a documents mirror (CAL-002) now.** Rejected for June scope: a second calendar read path + upsert/cancel reconciliation, more surface to get right. The cursor-only watch is the smaller correct step.
- (d) **Sweep-only (no push).** Workable and simplest, but loses the "prepped seconds after you book it" magic the webhook is for. Kept the push; the sweep is its safety net for the time-passing gap.

**Dependencies / deferred.**

- **Calendar push needs a domain-verified HTTPS callback** (GCP). No localhost in dev → tunnel for the push path, or test the sweep path locally. Plan Phases 0–2 (incl. the demoable `system.prepare_meeting` chat tool) carry **no** such dependency.
- **MEET-002** — delivery: pre-meeting email, web augmentation at send (`getWebSearchModel`), the in-app card (UI-001). The packet is reused; only near-send freshness/augmentation is new.
- **SEARCH-001** — promotes memory facts to a first-class cited `fact:` kind.
- **CAL-002 mirror**, **multi-calendar watch** — both deferred.

**Open (settle at build time from logs/testing, not now).**

- `selectThreads` recency window (start 90d), top-N caps (start 5/5/5), exact `material_hash` field set, horizon H (start 48h) + sweep cadence (start ~20m), `meeting_preps` sync prune window.

---

## ADR-0056 — Memory governance: autonomous-write + tiered notification + always-reversible; supersedes ADR-0019's confidence-gated HIL

**Decision.** Alfred mutates its own long-term memory **autonomously, via tool calls**, and stays trustworthy through **transparency + reversibility**, not pre-write gating. This replaces ADR-0019's posture (sub-0.85 facts blocked as `proposed` awaiting explicit accept). **Confidence stops gating the _write_ and starts gating the _notification cadence_ and the review _label_.** The boss/extractor writes; the user is **told** (tiered) and can **correct anytime**; the correction is simultaneously the authoritative contradiction signal (Loop 1) and a learning signal (Loop 2). The storage substrate (ADR-0019's `user_facts` status machine + `supersedes_id` chains + `rejected_inferences`, `entities`/`entity_relations`, `memory_chunks`, `style_profiles`) is **adopted as-is** — this ADR changes the _governance_, not the schema (modulo two additive columns).

**Knowledge taxonomy (the organizing spine).** Memory is reasoned about by _knowledge-kind_, not by table; each kind has its own capture source and lifecycle:

- **Identity** (`user_facts`, canonical keys) — onboarding + cold-start; stable, supersede on role/job change.
- **Standing instructions** (first-class; `user_preferences` + a directive notion) — say-it-in-chat + settings; persist until revoked.
- **People & relationships** (`entities` + `entity_relations`, the team graph) — onboarding + cold-start + email/calendar extraction; supersede on role change.
- **Episodic facts** (`user_facts` w/ `valid_until`) — extraction; TTL/decay (deferred → D2).
- **Style** (`style_profiles`) — sent-mail distillation; re-distilled.
- **Episodic memory** (`memory_chunks`) — thread summarization; window-pruned.

There is **no global TTL — lifecycle is per-kind.**

**Micro-decisions.**

1. **Autonomous write, no explicit-accept gate.** Facts at/above the existing floor (≥0.7; <0.7 still dropped, unchanged) are **written and live** — usable immediately. `proposed`/`confirmed` becomes a **review label** (UI emphasis + notification), not a write lock. The agent **hedges on low-confidence** facts in user-facing prose ("I think Alice is your manager — correct me if wrong"). Supersedes ADR-0019's "below 0.85 stays `proposed`, requires explicit accept."

2. **Writes go through `system.*` memory tools.** The boss mutates memory in-band via tool calls (`system.remember` / `system.update_fact` / `system.forget` / relationship-link tools — exact set in the plan). Background extraction calls the **same write functions**, so criticality classification, rationale capture, and notification fire uniformly regardless of caller. `system.*` → autonomy (ADR-0053); memory writes are reversible, so no HIL staging.

3. **Tiered, batched notification — two surfaces.** _In-app:_ `user_facts` is Replicache-synced (already carries `row_version`); changes appear **one-by-one** in a memory changelog/review surface in real time. _Email (via `notify()`, ADR-0020):_ **critical** changes batch on a **~5-min debounce** (multiples in the window collapse into one email — reuses the approval-debounce mechanism); **subtle** changes accumulate into a **digest flushed on count-threshold OR weekly, whichever fires first**. **Criticality** (principle; set tunable): identity change, key-relationship change, superseding a ≥0.85 fact, retracting a confirmed fact = critical; new low-stakes/low-confidence facts + additive aliases = subtle.

4. **Self-correction — two triggers in v1.** (i) **Write-time contradiction check** — a proposed fact is compared against existing facts on the same key/entity; on conflict it **supersedes** the prior (extends `proposeFact`/`supersedeFact`). (iii) **Behavioral/feedback** — user `confirm`/`edit`/`reject` is **authoritative and instant**. (ii) **Confidence-decay sweep** is **deferred → D2** (post-demo; needs real fact volume to tune).

5. **History is append-only — never hard-delete.** The `supersedes_id` chain + `status` (`edited | superseded | rejected`) + `valid_from`/`valid_until` preserve full chronological provenance. Retraction = a status flip + `valid_until`, never a row delete.

6. **Rejection provenance — new `cause` field.** Every fact death records _who/what_ caused it: the rejection record gains **`cause ∈ {user, write_time_contradiction, decay, superseded_by_newer}`** alongside the existing freeform `reason`. This is what lets Loop 2 separate _user corrections_ (high-value signal) from _system self-corrections_.

7. **Store the "why" — cheap-model terse rationale.** Every write persists evidence pointers (`source` jsonb, exists) **+ a rationale**: a **cheap-model ~2-sentence, telegraphic note (grammar-optional, token-frugal)** justifying the inference. This is the substrate for "justify our actions," surfaced through the **SEARCH-001** evidence layer — memory-justification and cited-outputs become **one mechanism, not two**. (ADR-0019 mandated a `source_id`; this adds the human-readable rationale, which extraction computes today but drops on write.)

8. **Loop 2 feeds the eval lane, never auto-tunes.** User corrections (especially `cause='user'`) accumulate as a **labeled misses dataset** routed to the eval lane (ADR-0055). **No prompt mutates automatically** — humans gate prompt/rubric changes (consistent with ADR-0050/0051's "principles over exemplars, tuned from logs"). `rejected_inferences` is the seed of this dataset.

**Schema delta (additive only).** `rejected_inferences.cause`, and a `rationale` on the write path (on `user_facts` or its `source` jsonb — settle during P2 implementation). No table redesign.

**What this amends / builds on.**

- **ADR-0019** — supersedes the confidence-gated HIL posture (no explicit-accept gate; `proposed` is a review label). Keeps its status machine, supersession chains, `rejected_inferences`, extraction triggers, and the memory page UX.
- **ADR-0020** — tiered/batched email rides the existing `notify()` fan-out + the approval-debounce mechanism; adds a `learned_fact` digest cadence.
- **ADR-0050 (D1/D2/D3)** — this is the build-out of the parked self-evolving-memory seeds; D2 (decay) stays deferred.
- **ADR-0055** — the eval lane is Loop 2's consumer.
- **ADR-0053** — memory write tools ride the dispatch floor + `system.*` autonomy.

**Alternatives.**

- (a) **Approve-before HIL for critical kinds.** Rejected: contradicts "Alfred has complete control," and the unattended review queue is exactly what rots today (ADR-0019's `proposed` facts with no surface). Reversibility + fast critical-notify is the lower-friction equivalent.
- (b) **Hybrid (autonomous high-confidence, approve-before low-confidence critical).** Rejected for v1 as needless complexity; hedge-on-low-confidence + 5-min critical email cover the risk. Revisit if a bad-write incident shows otherwise.
- (c) **Auto-tune prompts from corrections.** Rejected: silent self-modification of agent/classifier prompts is unsafe and unauditable; humans gate, evals measure.

**Deferred / Open.**

- **Confidence floor (0.7) + whether some surfaces exclude `proposed` facts** — tune from data.
- **Exact critical-vs-subtle set + digest count-threshold** — tune from notification-volume data.
- **Decay sweep (D2)** — post-demo.
- **The `system.*` memory write-tool surface** (names, schemas) — settle during P2 implementation in `docs/plans/long-term-memory-v1.md`.
- **Capture implementation details** — ADR-0057 locks the posture; concrete thresholds, budgets, and exact schemas tune during the phased build.

---

## ADR-0057 — Passive memory capture + the significance-score primitive + chat→memory write path

**Decision.** Memory **capture is fully passive**. The team graph + identity facts are inferred from integration signal (Gmail/Calendar) and **enriched/corroborated via web search**, written autonomously under ADR-0056, kept fresh by continuous extraction + Loop-1 supersession — **no active onboarding interrogation, no prompted confirmation card**. Web-search enrichment is gated by a new first-class **significance score** over `entities`, which is *also* the single source for todo personal-relevance (ADR-0050 **D1**), triage sender priority, and meeting-prep attendee prioritization. Direct user statements become durable memory through a two-path **chat→memory** write, with a durable-vs-run-scoped intent split. Companion to ADR-0056; the two together are the long-term-memory foundation. Build sequence + file detail in [docs/plans/long-term-memory-v1.md](./docs/plans/long-term-memory-v1.md).

**Micro-decisions.**

1. **Pure passive capture.** Onboarding stays minimal (connect only). The team graph + identity facts are inferred post-connect; correction is **unprompted** via the ADR-0056 review surface. No re-interrogation when teams change — the change surfaces in an integration and Loop-1 supersession catches it. First run shows a "still learning about you" state until ingestion + extraction land.

2. **Web-search enrichment, significance-gated + budget-capped.** Only entities **above a significance threshold** get a web-search dossier → a `person_profile` (builds ADR-0042's specced-but-unbuilt table); the long tail stays name + email. Web search both **enriches** (role, company) and **corroborates** a passively-inferred fact — corroboration raises confidence, feeding ADR-0056's confidence→notification tier. Reuses cold-start's Perplexity Sonar tooling + per-run cost ceiling (ADR-0011/0022, attachment-budget pattern).

3. **Significance score = first-class shared primitive.** A computed signal over `entities` (person/org): correspondence frequency + recency + reply-reciprocity + same-org-domain + explicit relationship edges. **One source, four consumers** — the enrichment gate, ADR-0050 **D1** todo significance, triage sender priority, meeting-prep attendee prioritization. Replaces four drifting "who matters" heuristics. This is the concrete build-out of the parked D1.

4. **chat→memory write path — two paths + an intent split.** (i) **In-band proactive:** the boss recognizes durable intent mid-conversation (not just literal "remember") and calls `system.remember`. (ii) **End-of-thread extraction** (ADR-0019's existing trigger) mines the closed thread for durable facts/prefs stated in passing. Capture is **proactive** (low write bar) because ADR-0056 reversibility + critical-tier notification make over-capture cheap to undo and under-capture the worse failure for an assistant. **Durable vs run-scoped split:** "for the rest of this conversation" → run-scoped directive (ADR-0035 `user_directives`, dies with the run); "from now on" → durable standing instruction (persisted). Only durable hits long-term memory.

5. **Standing instructions are a first-class knowledge-kind**, persisted (`user_preferences` + a directive notion — shape settled in the plan), and **ambient via Run grounding** (they bias every turn; relevance-filter if the set grows large).

**What this amends / builds on.**

- **ADR-0031** — supersedes "review before durable memory writes" for person dossiers (now autonomous + reversible per ADR-0056); keeps citation-grounding + the confidence-tier TTL cache.
- **ADR-0042** — **builds** `person_profiles` (the dossier cache, currently unbuilt); the `identity_confidence`-tier TTL stays.
- **ADR-0011 / ADR-0022** — extends cold-start web research from the user to the user's *significant people*, same tooling + budget posture.
- **ADR-0050 D1** — the significance score **is** the deferred personal-relevance primitive.
- **ADR-0056** — every write rides that governance; web-corroboration feeds confidence→notification.
- **ADR-0019 / ADR-0035** — chat→memory reuses end-of-thread extraction; the durable-vs-run-scoped directive split.

**Alternatives.**

- (a) **Active onboarding interrogation.** Rejected: friction on a sub-minute flow, half-filled forms, and teams change anyway (integrations re-capture).
- (b) **Confirm-card hybrid.** Rejected: prompted confirmation is friction; ADR-0056 reversibility + the review surface make *unprompted* safe.
- (c) **Web-enrich every contact.** Rejected: cost/latency; significance gate + budget cap instead.
- (d) **Per-feature "who matters" heuristics.** Rejected: four drifting copies; one shared significance score.
- (e) **Conservative chat capture (explicit "remember" only).** Rejected: under-capture is the worse failure for an assistant; reversibility makes proactive capture safe.

**Deferred / Open.**

- Significance score exact inputs/weights + threshold + enrichment budget — tune from data.
- `person_profiles` schema finalization (extends the ADR-0042 spec).
- Storage shape for standing instructions (`user_preferences` vs a sibling directive table) — settle during P5 implementation.
- First-run "still learning" UX.
- Confidence-decay sweep (D2) — still deferred (post-demo).
