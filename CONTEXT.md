# Alfred — Shared Vocabulary

Living glossary of the load-bearing terms. One to three lines per term. Refine in place when usage drifts; don't re-litigate in chat.

Cross-references: [`decisions.md`](./decisions.md) (the ADRs, snapshot table at the top), [`CLAUDE.md`](./CLAUDE.md) (operational guide).

---

## Core domain

**Skill.** A markdown body + frontmatter the agent mounts into its system prompt. Activated by `@skill:slug` in a brief or chat. Authoritative storage: `skills` + `skill_revisions`. ADR-0017.

**Workflow (row).** A row in the `workflows` table. Holds trigger spec, brief, optional steps DAG, status, allowed-integrations, HIL gates. Source of truth for the *settings UI* and the *trigger dispatcher* — not for execution shape.

**Workflow (code).** A `Workflow<S>` object passed to `registerWorkflow()` at server boot. Source of truth for *execution* (steps, initialState, dedupKey). Built-ins live as both a row AND a code object; user-authored live as a row only — registry misses route through a single shared `userAuthoredBriefWorkflow` sentinel only after the checked run resolver verifies `workflows (userId, slug)` exists and `is_builtin=false`. The requested slug, not the sentinel slug, stays the join key on `agent_runs.workflow_slug`; execution shape is shared.

**Run.** One execution of a workflow. Stored as one row in `agent_runs`. Joins back to the workflow via `agent_runs.workflow_slug`. There is no separate `workflow_runs` table — `agent_runs` covers status, timing, cost attribution.

**Brief.** Two scopes, both legitimate:
1. *Workflow brief* (ADR-0017): the user's natural-language description of what the workflow should do. Stored on `workflows.brief`.
2. *Sub-agent brief* (ADR-0026): the initial transcript handed to a spawned sub-agent. Stored as the first message of a child `agent_runs.transcript`.
   When ambiguous, qualify: "workflow brief" or "sub-agent brief."

**Trigger.** Discriminated union on `workflows.trigger.kind`: `cron` | `event` | `manual` | `on_signal`. The dispatcher consults `status='active'` before enqueuing a run.

**HIL gate.** A step id listed in `workflows.hil_gates`. The runtime parks the run on `wakeCondition.kind='hil'` when entering the step; user approval flips it back to `runnable`. Only meaningful with explicit `steps`. For brief-only workflows (m13+), HIL is driven by the **user action policy** instead — see below.

**User action policy.** Per-user row in `user_action_policies` storing `default_mode` (`autonomy` | `gated`), `integration_rules` jsonb keyed by integration slug, and `approval_notify_delay_ms`. The tool dispatcher consults it on every tool call; `gated` results land as staged actions awaiting human decision. Default at signup: `gated`, with `system.*` tools seeded to autonomy. ADR-0034.

**Policy mode.** `autonomy` (execute immediately) or `gated` (stage for HIL approval). Resolution at dispatch: **run-scoped auto-mode override → per-tool override → per-integration mode → user default**. Both modes are const-narrowed string unions from `@alfred/contracts`, never open strings.

**Auto mode (chat).** The composer's `autoMode` toggle ("auto mode" / "manual review", `dimension-chat-thread.tsx`). "Auto mode" = a per-thread blanket `autonomy` override captured onto each run and applied at the top of policy resolution; "manual review" = honor the durable `user action policy`. **Server-authoritative** once a run exists (the gate runs server-side and background runs have no browser). The eventual thread/conversation row stores the per-thread default; `localStorage`/global store holds only the new-chat default toggle position (default **manual**) until first send persists it. No riskTier carve-outs — auto mode is full autonomy for the thread (ADR-0034 alt-(f)). Wiring rides the m13 chat→runtime bridge. ADR-0034 amendment 2026-05-27.

**`@alfred/contracts`.** New tiny package (sibling to `@alfred/sync`, `@alfred/env`) holding cross-boundary types + const tables: `INTEGRATION_SLUGS`, `POLICY_MODES`, per-integration `*_ACTIONS` lists, derived `ToolName`, future attribution/signal kinds. Zero Node deps; importable from `packages/db`, `packages/api`, `apps/web` without runtime-bundle leaks. Pure named exports + `as const`; no side effects at import time.

**Tool name.** Canonical form `${IntegrationSlug}.${ActionSlug}` — both halves are const-narrowed unions from `@alfred/contracts`. Per-integration action lists (`SYSTEM_ACTIONS`, `GMAIL_ACTIONS`, `CALENDAR_ACTIONS`, …) compose via `INTEGRATION_ACTIONS` into a single `ToolName` template-literal type. `system.*` is for internal tools like `system.load_integration` and scratchpad operations. Schema columns and dispatcher signatures use `ToolName` exclusively; no open strings, no `string & { __brand }` shortcuts.

**Action staging.** Row in `action_stagings` — one per proposed tool call, gated or autonomy. Gated rows park the run on `wakeCondition.kind='hil'` with `approvalId=stagingId` until user decides (approve / edit / reject); autonomy rows transit `pending → executed` in ms. Idempotent on `(run_id, tool_call_id)` for crash-resume. Carries `row_version` for Replicache, `risk_tier` for UI/email snapshots, and `proposed_input_hash` for retry suppression. Canonical audit record for "what did Alfred try and what happened?" ADR-0034.

**Approval debounce.** When a gated staging row lands, SSE pokes the web UI immediately; a BullMQ delayed job is also scheduled using `user_action_policies.approval_notify_delay_ms` (default 5min). If the user decides in-app before the delay fires, the job is removed and no email goes out. If the job fires with the row still `pending`, it calls `notify({ userId, kind: 'approval', idempotencyKey: 'approval:' + stagingId, ... })`, sending one email per staging row. Tracked by `action_stagings.notify_after_at` (scheduled fire time) and `notified_at` (actual fire time). ADR-0034.

**Rejection contract.** When the user rejects a staged action, the boss's resumed turn receives a structured tool-result: `{ status: 'rejected_by_user', toolName, proposedInput, reason, retryPolicy: 'do_not_retry_identical' }`. The dispatcher *enforces* the retry policy: a second stage attempt with the same `(run_id, tool_name, hash(proposed_input))` synthesizes another rejection without re-staging or re-emailing. Reject UI exposes two affordances: "Reject and continue" (default) and "Reject and end run" (triggers `cancelRun(runId)` with `reason='cancelled_by_user'`). Reason text is required. Staging cards render a banner with the most recent rejection for the same `(user_id, tool_name)` if one exists in the last N days — so the user (and the boss, on resume) sees why a similar action was rejected before. ADR-0034.

**Tool risk tier.** Const-narrowed enum at tool registration time, declared in `@alfred/contracts`: `no_risk | low | medium | high`. Pure UX hint at v1 — the dispatcher reads only `user_action_policies`, never `riskTier`. Drives integration-card summaries ("Gmail — 12 tools (4 high, 5 medium, 3 low)"), staging-card badges, and email subject prefixes. Staged rows snapshot the risk tier so old approvals don't change copy after a registry edit. Authors classify on registration; trust-the-author at v1, custom lint rule when the registry grows past ~30 tools. ADR-0034.

**Write surface.** The set of write/mutating tools (`gmail.send_draft`, `calendar.create_event`, `docs.create`, `drive.share`, …) an integration exposes. First-class as of ADR-0043 — *not* walled off architecturally. Authorization is a three-layer composition: tool registry (does the tool exist?) → active tool exposure (`activeIntegrations` seeded by `@`-mentions and bounded by `workflows.allowed_integrations`, with `system.load_integration` enforcing the cap) → `user action policy` (`autonomy | gated`, default `gated`). Supersedes ADR-0033's "never expand the write surface" rule, which now scopes only to the tool-free briefing compose path. Safety moved from architecture to the policy default. ADR-0043.

**Publishing posture.** Google OAuth consent screen runs in **Production, deliberately unverified** (not Testing). Avoids Testing's 7-day refresh-token expiry for non-profile scopes; refresh tokens are still revocable and subject to Google's normal token limits. The trade is the unverified-app warning + 100-new-user cap, both fine at single-tenant scale. We never submit for verification, so "Google won't approve it" doesn't apply on this path. ADR-0044.

**Scope tier.** Google's three-way classification that sets the verification bar: **non-sensitive** (`drive.file`, `openid`, `email` — no sensitive/restricted scope review), **sensitive** (`gmail.send`, `calendar.events`, Workspace edit scopes — app verification, no security assessment), **restricted** (`gmail.modify`, full `drive` — restricted verification **+ annual security assessment if restricted data is stored/transmitted through servers**, the real public wall). Alfred requests least-privilege, extends freely into sensitive, and takes exactly one restricted scope (`gmail.modify`) because reading mail is the product. Granted set tracks the registered tool set. ADR-0044.

**Multi-tenant-capable / single-tenant operation.** Alfred is *architected* multi-tenant (per-user `integration_credentials`, `user_action_policies`, `user_id` partitioning) but *operated* as one tenant. "Single-user" (ADR-0001) is the current operating mode, not an architectural ceiling — going public is a verification submission + ADR-0009 allowlist removal, not a rewrite. A self-host-per-user model (each user = their own GCP project) is the open third path that avoids a centralized public OAuth client and its restricted-scope security assessment. ADR-0044.

## Compaction

**Transcript compaction.** Distinct executor step inserted between `dispatch-tools` and the next `boss-turn` when token-count crosses `compactionThresholdTokens(model.contextWindow)` (60% of context window). Compactor is `getCheapModel()`; output capped at 2000 tokens. The stable boss system prompt and tool definitions stay outside `agent_runs.transcript` as `AlfredAgent.turn()` inputs; the compactor preserves the in-flight tail (last assistant message + its tool calls + results) verbatim and compresses everything older into the run handoff. Sub-agents do not compact (fail back to the boss for re-decomposition per ADR-0026). ADR-0035.

**Run handoff.** Structured XML `<run_summary>` emitted by the compactor, replacing older transcript content. Sections: `goal`, `user_directives`, `decisions`, `actions_completed`, `actions_rejected`, `actions_failed`, `sub_agent_findings`, `pending_followups`, `key_entities`. A third ephemeral `cacheControl` breakpoint goes after the `<run_summary>` so subsequent turns hit a stable cached prefix until the next compaction. ADR-0035.

**User directives vs decisions.** Two distinct handoff sections by design. `<user_directives>` = pragmatic, mid-run intent statements that bound the agent's future behavior ("trust gmail for the rest of this conversation"), preserved verbatim. `<decisions>` = epistemic, facts/preferences/constraints learned during the run ("Alice is the manager"). The compactor's system prompt enforces "do not paraphrase under `<user_directives>`" — paraphrasing introduces drift on intent grants. ADR-0035.

## Scratchpad

**Run scratchpad.** Per-run K/V store for sub-agent findings + boss-promoted shared state. **Redis** is the live store during the run (keys `alfred:scratch:{runId}:{zone}.{path}`, 30-day TTL). **Postgres** receives a per-key snapshot via `agent_run_context` at the executor's terminal step (success / failure / cancel), idempotent via `ON CONFLICT (run_id, key) DO UPDATE`. Crash-resume of a lost scratch entry mid-run = re-execution of the producing step (ADR-0014's idempotency). Per-zone single-writer enforced at the dispatcher: only `sub_a` writes `scratch.sub_a.*`; only the boss writes `shared.*`. ADR-0036 (amends ADR-0016).

**`shared.*` vs `scratch.{subId}.*`.** Two namespaces inside the run scratchpad. `scratch.{subId}.*` is sub-agent advisory state (unvalidated; the sub-agent owns it). `shared.*` is boss-promoted canonical state (validated; only the boss writes). Sub-agents read both but write only their own zone. Cross-pollination across sub-agents flows through `shared.*` — the boss is the gate. ADR-0016 + ADR-0036.

**Active integrations.** `agent_runs.state.activeIntegrations: string[]` — the toolset the agent can currently call. **Strict seed** at run start: parsed `@<slug>` mentions in the brief, intersected with `workflows.allowed_integrations` (if non-empty). No fallback to "all connected integrations" — an empty seed is legitimate, and the boss grows the set via `system.load_integration(slug)` calls. Cap is always `workflows.allowed_integrations`. ADR-0026 amendment + ADR-0040.

**Builtin vs user-authored.** `workflows.is_builtin = true` for alfred-curated workflows seeded from the repo (immutable except `status`); `false` for user-authored (full CRUD). Same table, same toggle UX.

## Runtime primitives

**Tick.** A BullMQ repeatable that fans out per-user. Existing pattern: `briefing.tick` (hourly, `packages/api/src/modules/briefing/repeatable.ts`). m12 adds `workflows.tick` (every minute, generic) per ADR-0027.

**Dispatcher.** The piece that turns a trigger into a `createRun` + `enqueueRun` call. Exists implicitly per-feature today (e.g. the briefing tick handler); m12's `workflows.tick` is the first generic dispatcher.

**`next_run_at`.** Denormalized timestamp on the `workflows` row. Recomputed (via `cron-parser`) at exactly two moments: when `trigger`/`status` mutates, and inside the tick after a successful `createRun`. The tick query is an index lookup, not a scan. ADR-0027.

**`trigger` (on `agent_runs`).** First-class jsonb column on the run, mirroring `workflows.trigger.kind` plus per-kind metadata (`scheduledFor`, `eventId`, `payload`, `signalName`). Source of truth for "why did this run fire?" Replaces ad-hoc `metadata.triggeredBy` stuffing. ADR-0027.

**Scheduled-instant jobId.** BullMQ `jobId = workflow:{workflowId}:scheduled:{nextRunAtIso}`. Idempotency primitive: a retried tick is a no-op via BullMQ's native dedup without consulting Postgres. ADR-0027.

**Per-turn LLM driver.** `AlfredAgent` (ADR-0026, `packages/ai/src/agent.ts`). One `turn()` call = one LLM round-trip = one `api_call_log` row. Composes with the durable runtime; not yet wired into any agent_run.

**Brief-only execution shape.** Two named executor steps that ping-pong: `boss-turn` runs exactly one `AlfredAgent.turn()` (preserves ADR-0015's one-turn-one-`api_call_log` invariant); `dispatch-tools` calls `dispatchToolCall` for each returned tool call, appends results to the transcript, and either returns `next: 'boss-turn'` or `interrupt` if any call staged for HIL. Compaction (Phase 7) slots in as a third named step. The shared code-side `Workflow<S>` handles every user-authored brief — the slug on `agent_runs.workflow_slug` distinguishes runs, not their execution shape.

**System-tool dispatch contract.** `system.*` tools (`load_integration`, `spawn_sub_agent`, `read_scratch`, `write_scratch`, `promote`) are registered with the same `liveTool` factory as integration tools, but the dispatcher applies a **structural autonomy override**: `if (integration === 'system') policyMode = 'autonomy'`, ahead of the `user_action_policies` lookup. State-changing system tools (`load_integration`, `spawn_sub_agent`) take the full dispatcher path and land an `action_stagings` row for audit + crash-resume idempotency. Chatty no-op-side-effect system tools (scratchpad ops) get a fast-path that skips staging (Phase 6c). `execute` for system tools is **pure** — it validates and returns a structured result; mutation of `agent_runs.state` (e.g. appending to `activeIntegrations`) happens in the `dispatch-tools` step body, which interprets system tool results before the executor's atomic state commit. No tool reaches into runtime internals.

## Authoring shapes

**Brief-only workflow.** `steps = null`, `brief != null`. Runtime: a single `AlfredAgent`-driven loop with a stable boss system prompt, the workflow brief as the first user transcript message, and tools seeded/grown from `allowedIntegrations`. m12 stored and dispatched these but did not execute them — the planned stub was scoped out before ship, so pre-m13 code threw on registry miss. m13 adds the sentinel workflow + tool dispatch + `system.load_integration` + `AlfredAgent`→runtime bridge.

**Explicit-DAG workflow.** `steps != null`. Runtime executes deterministically; node kinds: `run_skill | tool_call | llm_call | agent_run | condition | parallel | loop | hil_approve`. The Zod schema exists; runtime support for these node kinds is partial (only `agent_run` is implicit via the executor; the rest are unbuilt).

**Hybrid workflow.** Explicit DAG with embedded `agent_run(brief)` nodes — deterministic outer, LLM-decided inner. Forward-compatible; not v1.

## Privacy posture

**Content-at-rest posture.** No app-layer encryption on user content. Three layers stand in: (1) vendor at-rest crypto on Railway managed Postgres/Redis/object storage, (2) log redaction via Pino + Sentry `beforeSend` for known sensitive paths (`*.content`, `*.extracted_text`, `*.body`, `memory_facts.value`, `attachment_pages.*`), (3) `documents.raw` is not persisted — re-extraction means re-fetch from the provider. Revisit when a real second-hand party touches the data (contractor, analytics pipeline, real backup-export workflow, compliance regime). ADR-0038.

**Embedding-inversion gap.** `chunks.embedding` is plaintext by design — encrypting kills pgvector indexing. Published inversion attacks can reconstruct text from vectors + the embedding model alone. Documented and accepted; the only defense is "trust your embedding provider," which is contractual. ADR-0038.

**`SENSITIVE_LOG_PATHS`.** Single const in `@alfred/contracts` listing redacted field paths. Pino, Sentry, and any future logger pull from this one source so the redaction set never drifts across log surfaces.

## Attachments

**Attachment.** A non-text payload arriving alongside a document — PDF, image, spreadsheet. Modeled as its own row in `attachments` (sibling to `documents`, not a row in it), linked back via `parent_document_id`. Carries identity (mime type, filename, size, page count), extraction status, and binary location. Drives a distinct ingestion path because its content shape (typed segments, pages, figures) doesn't fit `documents`'s "flat text body" assumption.

**Attachment page.** One row per page of an attachment in `attachment_pages`. The citation anchor — when the agent surfaces "from receipt.pdf, page 4," it's referencing one of these. Holds the page's concatenated `extracted_text` (for "summarize this page" without rejoining chunks) and an `asset_inventory` jsonb. Page = 1 for standalone image attachments.

**Typed segment / segment `kind`.** Each chunk derived from an attachment carries a `kind`: `text | table | figure_caption | heading | footnote | list`. Drives chunking rules (tables never split mid-row; headings become standalone chunks AND populate `parent_section` on subsequent siblings) and powers retrieval queries that want a specific element type ("find the table on page 3").

**Asset inventory.** Per-page jsonb on `attachment_pages`: `{ tableCount, figureCount, footnoteCount, hasImages, hasLinks, headings: string[] }`. Counted at extraction time. Lets retrieval answer "what attachments have charts" or "which page has the financial breakdown" without re-reading every chunk.

**Doc extraction.** The pipeline that turns a binary attachment (PDF or image) into typed segments + page inventory. Implemented as a Claude call with `document`/`image` content type, prompt-shaped to emit the canonical segment JSON. Metered as `attribution.kind = 'doc_extraction'` so cost rollups bucket it apart from LLM turns / web search / embeddings. Per ADR-0021's vendor alignment and the cost calculus at single-user scale. ADR-0039.

**`doc-extraction-runs` queue.** Dedicated BullMQ queue for attachment extraction, isolated from `ingestion-runs` so Anthropic latency/cost doesn't bleed into Gmail polling. Jobs: `attachment.extract { attachmentId }` (primary) + `doc-extraction.sweep` (hourly repeatable for stuck/failed rows). Worker concurrency 5, 3 attempts, 30s exponential backoff. Terminal failure flips `attachments.extraction_status='failed'` with `last_error` populated — the row IS the dead letter. ADR-0039.

**Attachment cost gates.** Four gates bound extraction spend: (1) MIME allowlist at enqueue (`pdf|png|jpeg|heic|webp`), (2) 20MB size cap at enqueue, (3) 50-page truncation at extraction time (`truncated_at_page` flagged), (4) $5/day per-user soft cap via env `ALFRED_DOC_EXTRACTION_DAILY_BUDGET_USD` — over-budget jobs `moveToDelayed(nextMidnight())`, not lost. Skipped attachments create a row with `extraction_status='skipped'` + `skipped_reason` so the UI can show them honestly. ADR-0039.

**Attachment binary lifecycle.** Binaries land in the Railway bucket on ingest and stay forever — independent of Gmail message retention. Gmail deletion does not cascade to the bucket or the chunks. A future explicit "forget this" UI handles real deletion intent. Inverse of ADR-0038's `documents.raw` posture: there Gmail is the durable copy; here the bucket is, because Gmail attachment availability is bounded by message lifetime. ADR-0039.

## Triage

**`SenderContext`.** Output of the deterministic `extract-sender-context` step that prefixes the triage pipeline. Shape: `{ fromKind: 'person' | 'service' | 'unknown', bodyActor?: { kind, name, handle? }, effectiveAuthor: 'bot' | 'person' | 'service' | 'unknown', botSlug?: BotSlug }`. Consumed by the cheap classifier as a typed input (not raw header text) and by the briefing's email contribution. Lives in `@alfred/contracts`. ADR-0042.

**Effective author.** Derived field on `SenderContext` — the actor who actually "wrote" the email considering both `From:` and body-actor extraction. Drives classifier rule 9a/9b/9c branching and gate condition (iii) on the escalation step. `'service'` is for cases where the envelope is a service (`noreply@github.com`) but no body-actor parser fired.

**Body actor parsing.** Per-service parsers that extract the underlying actor from a service-envelope email body. v1 covers GitHub (`**actor**` markdown), Google Calendar (iCal `ORGANIZER`), and Linear ("Comment from {actor}"). Long-tail sources fall through to `effectiveAuthor: 'unknown'` and the escalation gate's `confidence < 0.7` clause acts as the safety net. New parsers added from observed `triage.sender_extraction` log evidence, not speculation.

**Bot allowlist.** Hardcoded const `BOT_SLUGS` in `@alfred/contracts/triage`. Starts at ~10 entries (coderabbit, copilot-review, github-actions, dependabot, renovate, vercel, sentry, stripe-billing, google-security, datadog). Grows from observed log data. DB-backed migration only when the list passes ~20 entries. ADR-0042.

**`SEVERITY_SUSPECT_BOTS`.** Const subset of `BOT_SLUGS` marking bots whose alerts *can* be genuinely urgent — sentry, stripe-billing, google-security, vercel, datadog. Triage escalation gate fires on this set even when the cheap classifier output `fyi`. CodeRabbit / Copilot / Dependabot / Renovate are deliberately NOT in this set — their messages are advisory in 99% of cases and security-CVE exceptions are caught by classifier rule 9a's text-content escape.

**Deepen step.** Boss-agent brief-only run inside the triage workflow, gated by the escalation conditions. Read-only tool surface: `memory.read`, `github.list_repos`, `gmail.thread_history`. Refines classifier output and optionally emits a `dossierRequest` side-effect; triage never blocks on it — failure falls back to the cheap classifier's output. ADR-0042.

**Dossier cache TTL.** Per-`identity_confidence`-tier expiry on the `person_profiles` row (ADR-0031) that backs cached dossiers. ≥0.9 → 90d, 0.7-0.9 → 30d, <0.7 → 7d. Stale-and-important triggers re-research; cache key is the stable sender identifier — `email` for direct senders, `service:handle` for body actors (`github:coderabbitai`). ADR-0031 amendment + ADR-0042.

## Briefing

**Briefing.** One row in `briefings` per `(user_id, briefing_date)`. The canonical record of the day's morning briefing — the email is a render of `breaking_summary`, the in-app view renders `full_briefing`. Composed once per day via a single boss-tier LLM call over a cross-source gather. Idempotent on `(user_id, briefing_date)`; status-machine lifecycle. ADR-0041.

**Breaking summary.** The 4-6 lines of markdown prose sent in the day's morning email. Generated by the briefing composer alongside the full briefing — one LLM call emits both, no drift. Resolves `[[<kind>:<id>]]` placeholders into bold + service icon + anchor per the email HTML renderer.

**Full briefing.** The longer in-app surface for the day: `{ headline, sections: { source, label, body }[], reasoning }`. Replicache-synced read-only with a 30-day pull window; older briefings reachable via an on-demand `/api/briefings/history` route. Same prose source as the breaking summary — one composer truth, two renderers.

**Briefing reference.** `[[<kind>:<id>]]` placeholder in composed prose. Composer emits opaque tokens; a per-surface resolver expands against the gather (email: bold + icon + anchor; in-app: typed `<EntityChip>`; plain-text: fallback label). Prevents URL hallucination and decouples LLM content from presentation. Kinds at v1: `pr | commit | meeting | email | repo` (closed enum in `@alfred/contracts`). Unresolved placeholders fall back to inner label as text + log to observability — drift between gather and composer is a real risk worth surfacing.

**Gather source.** A per-integration contribution to the briefing's input. Each source registers a `BriefingContributor<T>` exposing `collect({ userId, date, timezone }) → T | null`. v1 sources: `email | calendar | github | weather | day_of_week`. Extensibility pattern mirrors ADR-0011 cold-start signals. Future integrations bolt on by adding a contributor + a `GatherSourceSlug` enum value + a schema branch; no workflow change.

**`IanaTimezone`.** Branded `string` type in `@alfred/contracts`, validated at the API boundary against `Intl.supportedValuesOf('timeZone')` (the live IANA list, ~400 zones). Persisted as `text` (no PG enum — IANA mutates per tzdata release). Used wherever the user's timezone has to round-trip through DB + API + Replicache safely, including `briefings.timezone`.

## m12 scope (locked 2026-05-11)

**Authoring + dispatch only. Execution deferred to m13.**

- 12a/12b/12c **CRUD + UI + Replicache sync** for skills and user-authored workflows. Brief-only authoring (no DAG editor). Schema column `workflows.steps` stays for forward-compat; API rejects writes to it.
- 12d **Trigger dispatch**: ship `cron` (UI + generic `workflows.tick` dispatcher) and `manual` ("Run now" button). `event` and `on_signal` segments render disabled in UI with a "lands with m13" tooltip; no dispatcher built. (ADR-0027.)
- 12e **Settings page**: unified active↔paused toggle for builtins + user-authored. Closes the m9 deferral.
- **Brief-only execution gap**: the originally planned m12 failed-run stub was scoped out before ship. Pre-m13, a user-authored workflow dispatch reached `createRun`, missed the in-memory registry, and threw before inserting a run row.
- m13 then builds the tool dispatcher + tool registry + `system.load_integration` + `AlfredAgent`→runtime bridge + sub-agents in one pass, fills the sentinel fallback, and lights up the History/Approvals tabs.
