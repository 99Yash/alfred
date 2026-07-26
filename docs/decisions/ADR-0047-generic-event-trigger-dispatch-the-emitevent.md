# ADR-0047 — Generic `event`-trigger dispatch: the `emitEvent` bus + triage unification


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
