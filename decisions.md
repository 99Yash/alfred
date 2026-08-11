# Alfred — Architectural Decisions

A running record of design decisions made while scoping alfred (a personal-assistant agent in the spirit of dimension.dev). Each entry: the choice, the rationale, alternatives considered, and any caveats.

---

## Snapshot

| Layer                 | Choice                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Monorepo              | pnpm + Turborepo                                                                                                  |
| Server package structure | `@alfred/http` adapters + `@alfred/assistant` product behavior; legacy `@alfred/api` is removed after extraction (ADR-0089) |
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
| Workflow trigger dispatch | Generic `workflows.tick` + denormalized `next_run_at` + unified `trigger` on `agent_runs`; durable database-unique occurrence claims are created with the run and cron cursor in one transaction, while BullMQ is delivery only (ADR-0027, amended by #558) |
| Composer voice input  | Browser-native `SpeechRecognition` (Web Speech API); no server STT (ADR-0028)                                     |
| Composer model picker | Opaque tiers (`Default` / `Pro`); never raw provider/SKU names (ADR-0029)                                         |
| Composer `+` menu / Tab autocomplete | Decoration-only in m12; behavior lands post-m13 (ADR-0030)                                         |
| People research       | Explicit, citation-grounded person dossiers; review before durable memory writes (ADR-0031)                       |
| Content privacy       | Content uses vendor at-rest crypto + log redaction; OAuth credentials use app-layer envelopes (ADR-0038 amendment) |
| Attachment ingestion  | `attachments` + `attachment_pages` tables; Claude PDF/image extraction; dedicated `doc-extraction-runs` queue; four-gate cost shield (ADR-0039) |
| Brief-only run shape  | Ping-pong `boss-turn` ↔ `dispatch-tools` steps; sentinel `userAuthoredBriefWorkflow` resolves all user-authored slugs; `agent_runs.transcript` jsonb; strict `@`-mention seed (ADR-0040)        |
| Daily briefing        | Renders of an **open-loop** model, not input summaries; **morning discretionary** (silent on quiet days, errs toward sending) + **evening always-fires** (degrades to weather + sign-off); compose-time **read-only reconciliation** (triage labels immutable); recall anchored to calendar; advance-reminders/anomaly-detection parked (ADR-0048, amends ADR-0041). Retained from ADR-0041: cross-source gather, boss compose, `[[<kind>:<id>]]` references, split email/in-app surface, `briefings` entity |
| Email triage pipeline | Layered: deterministic sender-context extraction + cheap classifier + boss `deepen` escalation gate + async dossier auto-trigger with confidence-tier TTL cache (ADR-0042)                       |
| In-app briefing surface | Paragraph-first day view (`breaking_summary` leads; `sourcePanels`/`sections` are collapsible support); day-keyed routes `/briefings` + `/briefings/$date` with stacked morning/evening slots; reference resolver relocated to `@alfred/contracts` so web resolves synced prose against synced `gather` (one truth, two renderers); no quiet-day mode; Replicache-only 30-day list via `IDB_KEY.BRIEFING` (ADR-0049) |
| Integration write surface | Write tools are first-class; authorization = tool registry + active tool exposure bounded by `workflows.allowed_integrations` + `user action policy` (default `gated`); no structural write-block (ADR-0043, supersedes ADR-0033's no-write rule) |
| OAuth posture | Multi-tenant-capable architecture, operated single-tenant; Google consent screen Production-unverified; least-privilege scope tiers, one restricted concession (`gmail.modify`); scope set tracks registered tools (ADR-0044) |
| Workflow event dispatch | Generic `emitEvent` bus; triage unified onto it (no more hardcoded fan-out); `source`+`type` closed enums (`gmail.message_received`); bounded resolve-at-init `<trigger_event>` context; bounded idempotency (ADR-0047, extends ADR-0027) |
| Todos | First **persisted** materialization of the open-loop model (ADR-0048 keeps loops ephemeral); one `todos` table, status-driven (`suggested\|open\|done\|dismissed`); hybrid authoring (user adds; Alfred proposes via `system.suggest_todo`, no HIL); multi-source `sources` provenance; v1 **passive** (agent authors + assists, never executes); **suggestions produced real-time off the `email-triage` run, not the briefing — briefing fully decoupled** (ADR-0050 amendment 2026-06-05); **todo-worthiness is an orthogonal rubric** (obligation → significance → memorability → actionability → already-handled), category floor shrunk to `{marketing, newsletter}`, decision traced via `todoDecision` (ADR-0050 amendment 2026-06-06); **stringency reframe — significance = real/external stake, manufactured + ceremonial urgency excluded, ownership-attribution gate (minimal identity), bot carve-out model-judged not slug-floored, terse-imperative voice, validated by a dry-run backfill** (ADR-0050/0051 amendment 2026-06-09); agent-execution + cross-source auto-close + semantic dedup + personal-relevance significance deferred (ADR-0050) |
| Tool surface | Exact, run-local `activeTools` separates model/run capability from the global registry. The dispatcher hard-enforces workflow integration caps and active membership before validation or execution; an allowed inactive call activates the exact schema and bounces the model to issue a fresh call. Legacy `activeIntegrations` checkpoints migrate at load. Exact search/preload and system-tool shrinking remain #411/#412 (ADR-0053 amendment, #407) |
| Memory store | **Postgres substrate over a graph DB**; build the memory *intelligence*, don't buy the *store*. ADR-0067 makes the user model a **multi-source observation log as system of record**, with stable `entity_nodes`/`entity_identities` as the foreign-key surface and `entity_profiles`/`entity_edges`/`entity_co_occurrence`/significance as replayable projections; `user_facts` subject-binding is P4-deferred. Graph as a **model**, not a graph **engine** (Neo4j/FalkorDB); adopting Zep/Mem0 would move truth off Postgres and break Replicache/reversibility. Borrow external patterns, not their store (ADR-0058/0067) |
| Triage significance | **Directional, per-relationship** todo significance (ADR-0050 **D1**, un-deferred) — the fix for failure A (cold inbound → `awaiting_reply` + "reply to X" todo). Significance score stays a **scalar** (ADR-0057); a **triage-local `Sender relationship` resolver** composes it with the sender `entities` row + the user's identity `user_facts` + a shared-org-domain test → `{relationType, direction, theirDesignation, yourRole}`, fed to rubric 16b (consume-not-infer; degrades to today's intrinsic-only when the graph is empty). **No self-entity** (derive direction from `user_facts`). 16a's founder/CEO/CTO LinkedIn carve-out deleted; **category stays honest**, the **todo** is gated, low-significance cold asks deprioritized within the bucket. Population is passive-capture only (never cold-start): **P4a** backfill over already-ingested correspondence now, **P4b** onboarding seed deferred behind the autonomy override; P3+P4a pulled ahead of the ADR-0058 suppression slice (ADR-0059) |
| Standing instructions | Durable user-stated **biases on existing pipelines** (triage/briefing/meeting-prep) — "tag X urgent", "stop nagging me about Ben", "keep recruiters out of my brief"; **not** workflow-authoring (that's ADR-0017/0027). ADR-0060 defined the projected shape in `user_facts` (`key="standing_instruction"`, `schemaVersion:2` = `directive` prose always + `target?` + `enforcement?`); ADR-0067 makes `source='user'|'alfred_chat'` observations the authoritative capture source and `user_facts` the projection consumed by retrievers. **Prose-first application** — agent consumers apply the directive by judgment; a thin deterministic `enforcement` carve-out is consumed only where a hard guarantee is needed. Conflict precedence is rank-then-recency at the observation fold, then specificity-then-recency among projected matching instructions; protective security floor beats a user down-rank, never an up-rank (ADR-0060/0067) |
| Meeting prep | Pre-meeting context note per calendar occurrence. Mirrors the briefing pipeline: deterministic **gather** (event + attendees + email threads from `documents` + memory facts + todos) → **boss-tier compose** (cited `[[meeting\|email\|todo:id]]` note) → persist to **`meeting_preps`** keyed `(user_id, event_key)`, **upsert/recompute-in-place**, Replicache-synced read-only. Proactive trigger folded in: **calendar `events.watch` push** (HTTPS callback, no event mirror; `syncToken` in credential metadata) + **48h horizon + ~20m sweep**, dispatched via the `emitEvent` bus — all three triggers converge on `system.prepare_meeting`. **Gated recompute** (`material_hash`): time-only event shift skips compose, material change recomputes — minimize compose *frequency*, not tier. Delivery (pre-meeting email, web augmentation) deferred to MEET-002 (ADR-0054) |

---

## Decision index

88 ADRs, one file each under [`docs/decisions/`](./docs/decisions/). Each
records the choice, the alternatives weighed, and why they lost — the part of the
design that the code cannot state. Read the two or three that touch your change;
this file exists so you never have to load all of them.

| ADR | Decision |
| --- | --- |
| [0001](./docs/decisions/ADR-0001-user-scope-single-user-with-multi-device-sync.md) | User scope: single user with multi-device sync |
| [0002](./docs/decisions/ADR-0002-package-manager-and-runtime-pnpm-node.md) | Package manager and runtime: pnpm + Node |
| [0003](./docs/decisions/ADR-0003-web-framework-vite-tanstack-router.md) | Web framework: Vite + TanStack Router |
| [0004](./docs/decisions/ADR-0004-calling-scope-tool-function-calling-only.md) | "Calling" scope: tool/function calling only |
| [0005](./docs/decisions/ADR-0005-realtime-layer-outbox-redis-pub-sub-elysia-sse.md) | Realtime layer: outbox + Redis Pub/Sub + Elysia SSE |
| [0006](./docs/decisions/ADR-0006-agent-runtime-roll-your-own-durable-execution.md) | Agent runtime: roll-your-own durable execution |
| [0007](./docs/decisions/ADR-0007-hosting-railway.md) | Hosting: Railway (one platform for everything) |
| [0008](./docs/decisions/ADR-0008-database-railway-managed-postgres-with-pgvector.md) | Database: Railway-managed Postgres with pgvector |
| [0009](./docs/decisions/ADR-0009-auth-better-auth-magic-link-passkey-allowlist.md) | Auth: Better Auth + magic link + passkey + allowlist |
| [0010](./docs/decisions/ADR-0010-data-access-pattern-hybrid.md) | Data access pattern: hybrid (ingest + live) |
| [0011](./docs/decisions/ADR-0011-cold-start-research-at-signup.md) | Cold-start research at signup |
| [0012](./docs/decisions/ADR-0012-memory-architecture-structured-tables-pgvector.md) | Memory architecture: structured tables + pgvector |
| [0013](./docs/decisions/ADR-0013-style-profiles-dedicated-table-channel-audience.md) | Style profiles: dedicated table, channel × audience keyed |
| [0014](./docs/decisions/ADR-0014-deploy-safety-durable-resume-with-idempotent.md) | Deploy safety: durable-resume with idempotent steps |
| [0015](./docs/decisions/ADR-0015-cost-token-metering.md) | Cost / token metering |
| [0016](./docs/decisions/ADR-0016-multi-agent-orchestration-boss-isolated-sub.md) | Multi-agent orchestration: boss + isolated sub-agents + boss-only-writes run-context |
| [0017](./docs/decisions/ADR-0017-skills-workflows-skills-are-markdown-workflows.md) | Skills + workflows: skills are markdown, workflows are trigger + brief + optional step DAG |
| [0018](./docs/decisions/ADR-0018-mcp-scope-client-side-only-at-v1.md) | MCP scope: client-side only at v1 |
| [0019](./docs/decisions/ADR-0019-memory-correction-loop-ux.md) | Memory correction loop UX |
| [0020](./docs/decisions/ADR-0020-notifications-email-only-at-v1.md) | Notifications: email only at v1 |
| [0021](./docs/decisions/ADR-0021-embedding-model.md) | Embedding model |
| [0022](./docs/decisions/ADR-0022-web-search-provider-perplexity.md) | Web search provider: Perplexity (Sonar Pro + Sonar Deep Research) |
| [0023](./docs/decisions/ADR-0023-observability-sentry-posthog-langfuse.md) | Observability: Sentry + PostHog + Langfuse |
| [0024](./docs/decisions/ADR-0024-per-integration-real-time-update-policy.md) | Per-integration real-time update policy |
| [0025](./docs/decisions/ADR-0025-built-in-background-workflows.md) | Built-in background workflows (v1 feature set) |
| [0026](./docs/decisions/ADR-0026-alfredagent-per-turn-llm-driver-not-a-tool-loop.md) | `AlfredAgent`: per-turn LLM driver, not a tool-loop wrapper |
| [0027](./docs/decisions/ADR-0027-workflow-trigger-dispatch-generic-workflows.md) | Workflow trigger dispatch: generic `workflows.tick` + denormalized `next_run_at` + unified `trigger` on `agent_runs` |
| [0028](./docs/decisions/ADR-0028-composer-voice-dictation-web-speech-api-browser.md) | Composer voice dictation: Web Speech API, browser-native, no server round-trip |
| [0029](./docs/decisions/ADR-0029-composer-model-picker-opaque-semantic-tiers.md) | Composer model picker: opaque semantic tiers, never provider names |
| [0030](./docs/decisions/ADR-0030-composer-menu-and-tab-autocomplete-deferred-to.md) | Composer `+` menu and tab-autocomplete: deferred to post-m13 |
| [0031](./docs/decisions/ADR-0031-people-research-dossiers-explicit-citation.md) | People research dossiers: explicit, citation-grounded, review-before-memory |
| [0032](./docs/decisions/ADR-0032-burst-dedup-on-per-credential-ingestion-bullmq.md) | Burst dedup on per-credential ingestion: BullMQ `deduplication: { id, ttl }`, never a static `jobId` |
| [0033](./docs/decisions/ADR-0033-daily-briefing-fidelity-is-bounded-by-per.md) | Daily briefing fidelity is bounded by per-source OAuth: Google now, GitHub queued |
| [0034](./docs/decisions/ADR-0034-human-in-the-loop-approval-taxonomy-action.md) | Human-in-the-loop approval taxonomy + action staging |
| [0035](./docs/decisions/ADR-0035-transcript-compaction-cheap-tier-handoff.md) | Transcript compaction: cheap-tier handoff summary at 60% threshold |
| [0036](./docs/decisions/ADR-0036-redis-as-scratchpad-primary-postgres-as.md) | Redis as scratchpad primary; Postgres as terminal snapshot |
| [0037](./docs/decisions/ADR-0037-gmail-realtime-ingestion-via-messages-list.md) | Gmail realtime ingestion via `messages.list`; `history.list` demoted to catch-up |
| [0038](./docs/decisions/ADR-0038-content-at-rest-posture-vendor-crypto-only-no.md) | Content uses vendor crypto; OAuth credentials use app-layer envelopes |
| [0039](./docs/decisions/ADR-0039-email-attachment-ingestion-dedicated.md) | Email attachment ingestion: dedicated `attachments` family, page-bounded typed chunks, separate extraction queue |
| [0040](./docs/decisions/ADR-0040-m13-phase-4-brief-only-execution-ping-pong.md) | m13 Phase 4 brief-only execution: ping-pong steps, sentinel workflow, dedicated transcript column, system-tool autonomy override |
| [0041](./docs/decisions/ADR-0041-daily-briefing-v2-cross-source-llm-compose.md) | Daily briefing v2: cross-source LLM compose, split surface, `briefings` entity |
| [0042](./docs/decisions/ADR-0042-email-triage-v2-layered-pipeline-with.md) | Email triage v2: layered pipeline with deterministic sender extraction + cheap classifier + boss escalation + async dossier trigger |
| [0043](./docs/decisions/ADR-0043-integration-write-surface-tools-may-write.md) | Integration write surface: tools may write, authorization is the user action policy |
| [0044](./docs/decisions/ADR-0044-google-oauth-posture-multi-tenant-capable.md) | Google OAuth posture: multi-tenant-capable architecture, Production-unverified single-tenant operation, least-privilege scope tiers |
| [0045](./docs/decisions/ADR-0045-per-document-ingestion-cost-guard-free-pre.md) | Per-document ingestion cost guard: free pre-flight estimate, reject-on-exceed, passive row status |
| [0046](./docs/decisions/ADR-0046-per-run-cost-ceiling-for-looping-agent-workflows.md) | Per-run cost ceiling for looping agent workflows (stub, deferred) |
| [0047](./docs/decisions/ADR-0047-generic-event-trigger-dispatch-the-emitevent.md) | Generic `event`-trigger dispatch: the `emitEvent` bus + triage unification |
| [0048](./docs/decisions/ADR-0048-briefing-v3-open-loop-unit-discretionary.md) | Briefing v3: open-loop unit, discretionary morning + always-on evening, compose-time read-only reconciliation |
| [0049](./docs/decisions/ADR-0049-in-app-briefing-surface-paragraph-first-day.md) | In-app briefing surface: paragraph-first day view, day-keyed routes, resolver relocated to `@alfred/contracts` |
| [0050](./docs/decisions/ADR-0050-todos-persisted-open-loops-hybrid-authored-one.md) | Todos: persisted open loops, hybrid-authored, one-table status model, passive v1 |
| [0051](./docs/decisions/ADR-0051-email-triage-v3-cheap-model-always-made-smart.md) | Email triage v3: cheap-model-always, made smart by deterministic context (sender priors + account persona + observation/inconsistency layer); supersedes ADR-0042's classifier shape |
| [0052](./docs/decisions/ADR-0052-github-loop-reconciliation-api-native-produce.md) | GitHub loop reconciliation: API-native produce + reconcile of persisted todos, polling v1, GitHub App webhooks deferred |
| [0053](./docs/decisions/ADR-0053-deterministic-connected-tool-declaration.md) | Deterministic connected tool declaration + dispatch-enforced gates; supersedes the prompt-only load instruction of ADR-0026/0040 |
| [0054](./docs/decisions/ADR-0054-meeting-prep-persisted-per-occurrence-packet.md) | Meeting prep: persisted per-occurrence packet (recompute-in-place) + calendar-watch-driven proactive trigger (horizon + sweep) |
| [0055](./docs/decisions/ADR-0055-eval-lane-local-evalite-deterministic-llm-judge.md) | Eval lane: local evalite, deterministic + LLM-judge scorers, dev tier now (CI/regression deferred) |
| [0056](./docs/decisions/ADR-0056-memory-governance-autonomous-write-tiered.md) | Memory governance: autonomous-write + tiered notification + always-reversible; supersedes ADR-0019's confidence-gated HIL |
| [0057](./docs/decisions/ADR-0057-passive-memory-capture-the-significance-score.md) | Passive memory capture + the significance-score primitive + chat→memory write path |
| [0058](./docs/decisions/ADR-0058-memory-store-the-postgres-substrate-over-a.md) | Memory store: the Postgres substrate over a graph DB; build the memory intelligence, don't buy the store |
| [0059](./docs/decisions/ADR-0059-directional-significance-for-triage-build-d1-as.md) | Directional significance for triage: build D1 as a triage-local Sender relationship resolver (no self-entity); pull P3/P4a ahead of the suppression slice |
| [0060](./docs/decisions/ADR-0060-standing-instructions-prose-first-central-store.md) | Standing instructions: prose-first central store + a deterministic enforcement carve-out |
| [0061](./docs/decisions/ADR-0061-replicache-stays.md) | Replicache stays (maintenance-mode dependency accepted), Zero is the watched migration path |
| [0062](./docs/decisions/ADR-0062-integration-object-state-memory-a-deterministic.md) | Integration object-state memory: a deterministic, registry-driven external-object projection on the Postgres substrate (extends ADR-0058/0057/0053/0052; resolves #212) |
| [0063](./docs/decisions/ADR-0063-integration-extraction-front-door.md) | Integration extraction front-door (DEFERRED — framed, not yet designed) |
| [0064](./docs/decisions/ADR-0064-presentation-layer-attention-scoring-demote.md) | Presentation-layer attention scoring: demote demanding-ness at the briefing lane + inbox rail, never the immutable category (resolves #210; folds in #230; Tier 2 of #218) |
| [0065](./docs/decisions/ADR-0065-chat-file-uploads-degrade-every-non-universal.md) | Chat file uploads: degrade every non-universal modality to text+images at ingest; the boss never sees a file type a model can't read |
| [0066](./docs/decisions/ADR-0066-triage-user-model-the-category-becomes.md) | Triage user-model: the category becomes significance-weighted (reverses ADR-0059); envelope + user-role + standing-instruction signals make the cheap model see who the user is |
| [0067](./docs/decisions/ADR-0067-multi-source-user-model-substrate-an-event.md) | Multi-source user-model substrate: an event-sourced observation log as the system of record, with entities/identities/relations/significance/facts as replayable projections (extends ADR-0012/0056/0057/0062; amends ADR-0057's direct-upsert capture; re-scopes ADR-0066; Tier of #218) |
| [0068](./docs/decisions/ADR-0068-tool-time-grounding-structured-relative-windows.md) | Tool time-grounding: structured relative windows resolved server-side in the user's timezone + reject invented/colliding search qualifiers, never trust the LLM to free-hand an external query DSL (resolves #213) |
| [0069](./docs/decisions/ADR-0069-high-risktier-tools-always-confirm-a-hard.md) | High-`riskTier` tools always confirm: a hard approval floor the autonomy toggle cannot override (reverses ADR-0034 alt-(f); supersedes ADR-0050's "no structural risk gate") |
| [0070](./docs/decisions/ADR-0070-persistence-poison-resistance-a-non-progressing.md) | Persistence poison-resistance + a non-progressing-step backstop: no tool result can wedge a run, and a step that can't commit dies instead of looping (resolves #267) |
| [0071](./docs/decisions/ADR-0071-tools-tell-the-truth-about-their-capability-and.md) | Tools tell the truth about their capability, and correctness is enforced at the result boundary, not only the input schema (extends ADR-0053/0068; resolves #222; closes the issue-summary give-up) |
| [0072](./docs/decisions/ADR-0072-chat-failure-taxonomy-is-structured-not-sniffed.md) | Chat failure taxonomy is structured, not sniffed: an attachment-presence gate, a narrowed signal set, and terminal-aware finalization (resolves #269) |
| [0073](./docs/decisions/ADR-0073-sub-agent-join-via-a-child-completion-wake.md) | Sub-agent join via a child-completion wake signal, not scratch-polling (BUILT + reliability backstops PR #274; child streams its trail into the parent's chat turn, amended 2026-07-26; finalization invariant deferred — see amendments) |
| [0074](./docs/decisions/ADR-0074-general-invocation-tier-for-breadth-composition.md) | General invocation tier for breadth, composition, and BYO-MCP: a raw read-passthrough now-ish, Code-Mode-style sandboxed code later (FRAMED — DEFERRED, not designed) |
| [0075](./docs/decisions/ADR-0075-produce-artifact-capability-the-agent-generates.md) | Produce-artifact capability: the agent generates artifacts (PDF/slides/sheets/docs) and renders them inline, agent-authored not Google-exported (DESIGNED — v1 in progress, see docs/plans/artifact-sidebar-v1.md) |
| [0076](./docs/decisions/ADR-0076-system-fetch-url-is-an-autonomous-arbitrary-url.md) | `system.fetch_url` is an autonomous arbitrary-URL GET: SSRF-guarded at connect time, audited via the action_stagings row (incl. redirect chain), accepted exfil risk at single-user blast radius (BUILT — #286; extends ADR-0070/0071) |
| [0077](./docs/decisions/ADR-0077-interactive-chat-tier-table-and-boss-charter.md) | Interactive-chat tier table and boss charter: Auto on Sonnet 4.6, Deep on Opus 4.8 (BUILT — #312; amended 2026-07-02) |
| [0078](./docs/decisions/ADR-0078-per-model-capability-is-code-resident.md) | AI SDK/provider packages own model mechanics; Alfred owns semantic route and rollout policy (original code-resident capability registry built in #313, superseded by the 2026-08-09 amendment) |
| [0079](./docs/decisions/ADR-0079-memory-capture-is-gated-deterministically-at.md) | Memory capture is gated deterministically at two layers (write-invariant vs document-attribution), with one canonical fact ontology, read-side convergence, and hold-`proposed` conflict detection (DESIGNED — in progress, see docs/plans/memory-capture-hardening.md) |
| [0080](./docs/decisions/ADR-0080-identity-facts-are-a-deterministic-projection.md) | Identity facts are a deterministic projection over the ADR-0067 observation log, not direct writes; aboutness-by-construction + "no grounding, no row" (DESIGNED — grilled 2026-06-29, see docs/plans/identity-facts-projection-v1.md) |
| [0081](./docs/decisions/ADR-0081-non-prod-must-not-mutate-the-shared-gmail.md) | Non-prod must not mutate the shared Gmail mailbox: one explicit `GMAIL_MAILBOX_WRITES_ENABLED` gate at the write boundaries (BUILT — #278) |
| [0082](./docs/decisions/ADR-0082-one-canonical-timezone-preference-key-grounds.md) | One canonical `timezone` preference key grounds both chat and briefing; captured at onboarding (BUILT — #229) |
| [0083](./docs/decisions/ADR-0083-briefing-context-signals-are-a-typed-middle.md) | Briefing context signals are a typed middle layer between source evidence and prose, and briefing prose never writes durable facts (BUILT: contract + policy — #415; consumers deferred, under #218) |
| [0085](./docs/decisions/ADR-0085-long-form-document-artifacts-author.md) | Long-form `document` artifacts author incrementally via a capped `create` → `append_artifact_section` shape; the tool description is the forcing function and the per-call cap is a backstop (SHIPPED — Gap 2, under the ADR-0075 artifact epic; live re-probe PASSED 2026-07-14) |
| [0086](./docs/decisions/ADR-0086-artifact-fancy-on-demand-is-a-curated.md) | Artifact "fancy on demand" is a curated capability vocabulary (motion / marks / diagrams / charts) added the way themes+archetypes were — named primitives in the retroactive shell, under one governed expression dial — and ships inside today's sealed sandbox; a headless render surface (fit-check → vision-repair → optional CDN assets) is the deferred substrate that lifts the ceiling (DESIGNED — 2026-07-15, see docs/plans/artifact-expression-system-v1.md) |
| [0087](./docs/decisions/ADR-0087-code-mode-rung-b-v1-is-context-virtualization.md) | Code-Mode rung-(b) v1 is context virtualization, not composition/BYO-MCP: object handles + a network-less self-hosted isolate whose only capabilities are host functions (DESIGNED — grilled 2026-07-21, see docs/plans/code-mode-object-handles-v1.md) |
| [0088](./docs/decisions/ADR-0088-the-mcp-call-approval-floor-is-a-floor-not-a.md) | Dynamic tool risk resolves fail-closed at the dispatch gate: reviewed MCP downgrades require an audited declaration, invalid/undeclared downgrades clamp to the static tier, Calendar invites raise `medium` to `high`, and resumed pending rows can only gain approval requirements (BUILT — #541 Part 3, amended by #232; amends ADR-0069) |
| [0089](./docs/decisions/ADR-0089-name-http-and-assistant-packages-by-ownership.md) | Name HTTP adapters and assistant behavior by ownership; break cycles before extraction |

## Appendices

- [Open / deferred](./docs/decisions/open-deferred.md)
- [Suggested implementation order](./docs/decisions/implementation-order.md)
