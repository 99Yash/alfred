# m13 — Boss + sub-agent orchestration (implementation plan)

m13 fills the user-authored workflow execution gap left after the planned m12 `user_authored_brief_execution_pending_m13` stub was scoped out, then ships the full boss-agent runtime. It lands three new ADRs in one milestone: **0034** (HIL approval + action staging), **0035** (transcript compaction at 60%), **0036** (Redis-primary scratchpad with Postgres terminal snapshot), on top of **0016** (sub-agent fan-out) and **0026** (`AlfredAgent` per-turn driver).

This is a phased plan. Each phase is "land before the next phase starts"; sub-steps inside a phase are parallel-safe.

Cross-references: [`../../CONTEXT.md`](../../CONTEXT.md) (glossary — `User action policy`, `Action staging`, `Tool name`, `Run scratchpad`, `Transcript compaction`, etc.), [`../../decisions.md`](../../decisions.md) (ADRs 0014, 0016, 0017, 0026, 0027, 0034, 0035, 0036).

---

## Sequencing constraints (read first)

1. **`@alfred/contracts` is the chokepoint.** Schemas can't type their `ToolName` columns, the dispatcher can't compile, and the web UI can't share enums until the contracts package exists. Land it as its own PR; rebase everything downstream on it.
2. **Dispatcher precedes the agent bridge, which precedes sub-agents.** Sub-agents are just child runs that share the same dispatcher. Building them before the dispatcher exists produces a parallel implementation that gets thrown away.
3. **HIL UI can lag the dispatcher.** During development, approving via direct DB writes is fine. Don't block dispatcher work on `/approvals` page work.
4. **Compaction lands inside m13 even if it sits unused at first.** Sub-agent fan-out will push transcripts past the 60% threshold quickly; shipping m13 without it is shipping a known quality cliff.

---

## Open ADR items to settle during Phase 3

- **ADR-0034 open:** Whether `policy-bust:u:<userId>` rides as a sibling Redis Pub/Sub channel or as a new kind on ADR-0005's existing outbox bus. Default plan: sibling channel.
- **ADR-0036 open:** Boss synthesis read pass — SCAN `MATCH alfred:scratch:{runId}:scratch.*` vs. maintaining a per-sub_id index list. Default plan: SCAN; revisit only if profiling shows it dominating.

Decide both in the Phase 3 PR description so reviewers know what was chosen and why.

---

## Phase 1 — Foundations

Goal: unblock every downstream package by landing the shared types and tables.

### 1a. `@alfred/contracts` package

New sibling to `@alfred/env` / `@alfred/sync`. Zero Node deps. Pure named exports + `as const`; no side effects at import time. Importable from `packages/db`, `packages/api`, `apps/web`.

Exports:

- `POLICY_MODES` + `PolicyMode` type
- `INTEGRATION_SLUGS` + `IntegrationSlug` type
- `SYSTEM_ACTIONS`, `GMAIL_ACTIONS`, `CALENDAR_ACTIONS`, … + `INTEGRATION_ACTIONS` const map. `system.*` covers internal tools (`system.load_integration`, `system.spawn_sub_agent`, `system.read_scratch`, `system.write_scratch`, `system.promote`) so they are typed and audited like integration tools.
- Derived `ToolName` template-literal type: `${IntegrationSlug}.${ActionSlug}`
- `TOOL_RISK_TIERS` + `ToolRiskTier` type
- `IntegrationRule` + `IntegrationRules` shapes for `user_action_policies.integration_rules`
- Scratchpad key builders: `sharedKey(runId, path)`, `subAgentKey(runId, subId, path)`
- Compaction: `COMPACTION_THRESHOLD_PCT = 0.60`, `compactionThresholdTokens(modelContextWindow)`
- Stable input hashing: `hashToolInput(toolName, input)` using canonical JSON. The dispatcher stores the result on `action_stagings.proposed_input_hash`; retry suppression must not depend on ad hoc `JSON.stringify` ordering.

Backfill the action lists for Gmail (and Calendar if the surface area is locked) so `ToolName` is non-empty at first cut. Other integrations register their actions when they ship a `liveTool`.

### 1b. Schema migrations

One migration per table (generate → migrate; never `db:push`). Update `packages/db/src/schema/*.ts` and re-export through `packages/db/src/schemas.ts`.

- **`user_action_policies`** — see ADR-0034 schema sketch. Use `.$type<IntegrationRules>()` on the jsonb column. Default row inserted on signup with `default_mode='gated'`.
- **`action_stagings`** — see ADR-0034 schema sketch. Required implementation additions: `row_version integer not null default 1` for Replicache, `proposed_input_hash text not null` for retry suppression, and `risk_tier text not null` as a snapshot for email/UI copy even if registry metadata changes after staging. Indexes: `(user_id, status) WHERE status='pending'`, `(run_id)`, `(run_id, tool_name, proposed_input_hash) WHERE status='rejected'`, unique `(run_id, tool_call_id)`. `tool_name` typed as `ToolName` via `.$type<ToolName>()`.
- **`model_prices.context_window`** — integer column added to existing `model_prices` table. Update `packages/db/src/scripts/sync-prices.ts` to read context-window/capability data from models.dev and populate this column; do not just add the column.
- **Wake condition compatibility** — current runtime uses `WakeCondition = { kind: 'hil'; approvalId: string; prompt?: string }`. Extend it to distinguish `{ approvalKind: 'step' | 'action_staging' }`; staged approvals use `approvalId = stagingId` consistently across `interrupt`, `signalRun`, and SSE payloads. Do this deliberately before dispatcher tests.

Update `apps/server/.env` and `.env.example` if any new env vars are needed (none expected for this phase).

### 1c. Signup hook

Use the existing `registerOnUserCreated` fan-out in `packages/auth` / `apps/server/src/index.ts`. Add a server bootstrap hook next to `seedBuiltinWorkflowsForUser(user.id)` that inserts the default `user_action_policies` row with `default_mode='gated'`, `integration_rules` containing `system: { mode: 'autonomy' }`, and the default approval notification delay. Keep it idempotent so a retried Better Auth `after` hook is harmless.

### Phase 1 acceptance

- `pnpm check-types` clean across the workspace.
- New signups get a row in `user_action_policies`.
- `SELECT context_window FROM model_prices WHERE provider='anthropic'` returns non-null values after `pnpm --filter @alfred/db db:sync-prices`.
- `import { sharedKey } from '@alfred/contracts'` compiles in `packages/api`, `packages/db`, and `apps/web` without dragging Node-only modules into the web bundle.

---

## Phase 2 — Runtime primitives

Goal: stand up the storage layers the dispatcher and sub-agents will read/write.

### 2a. Redis scratchpad helpers (ADR-0036)

In `packages/api/src/modules/scratchpad/` (or similar):

- `writeScratch({ runId, zone, subId?, path, value, writtenBy })` — JSON-serializes a `ScratchEntry`, `SET key value EX 2592000`.
- `readScratch<T>({ runId, zone, subId?, path }): Promise<ScratchEntry<T> | null>`.
- `promoteScratch({ runId, fromSubId, fromPath, toSharedPath })` — read-then-write; boss-only. Single-writer-per-zone enforced inside the dispatcher (a child run's `write_scratch` tool can only target its own `scratch.{subId}.*`).
- `snapshotScratchToPostgres(runId)` — terminal-step routine; SCAN keys, INSERT `agent_run_context` with `ON CONFLICT (run_id, key) DO UPDATE`.

Connection uses `createRedisConnection()` from the existing queue connection factory.

### 2b. Tool registry shape

`liveTool({ integration, action, riskTier, description, inputSchema, execute })` returns a registry entry. `name` is derived: `${integration}.${action}`, typed as `ToolName`.

Internal tools use the same registry under the `system.*` namespace but resolve to autonomy through the default system policy. Do not use `riskTier` as a gating shortcut; it remains a UX hint only.

Implement the initial slice — enough to exercise both autonomy and gated paths through the dispatcher:

- `gmail.search` — `riskTier: 'no_risk'`
- `gmail.send_draft` — `riskTier: 'high'`
- `calendar.list_events` — `riskTier: 'no_risk'`
- `calendar.create_event` — `riskTier: 'medium'`

Tools are registered at server boot inside integration-owned modules under `packages/api/src/modules/tools/`. The registry exposes `getTool(toolName)` and `listToolsForIntegration(slug)`.

### Phase 2 acceptance

- Unit-test `writeScratch` + `readScratch` round-trip on a real local Redis.
- `snapshotScratchToPostgres` is idempotent against retry (call twice, second call is a no-op via `ON CONFLICT DO UPDATE`).
- `getTool('gmail.search')` resolves; `getTool('gmail.fake_action' as ToolName)` is a compile error.

---

## Phase 3 — The dispatcher (the spine)

Goal: every tool call routes through one function. Autonomy and gated paths both produce `action_stagings` rows; gated paths interrupt the run.

### 3a. Policy resolution + cache

- `resolvePolicyMode(userId, toolName)`: in-process Map cached by `userId`. Read order: tool override → integration mode → user default.
- Bust on update: subscribe to `policy-bust:u:<userId>` Redis Pub/Sub channel; on receive, delete the in-process cache entry. Publishing happens inside the API mutation that updates `user_action_policies`.

### 3b. Dispatch flow (per ADR-0034)

```
dispatchToolCall({ runId, stepId, toolCallId, toolName, input, userId }):
  1. validate input against tool.inputSchema       → synth validation-error result on failure
  2. proposedInputHash = hashToolInput(toolName, input)
  3. retry-suppression check                       → synth rejected_by_user result if hash matches recent rejection
  4. resolve policy mode                           → 'autonomy' | 'gated'
  5. INSERT action_stagings (status='pending', proposed_input_hash, risk_tier, requires_approval = mode==='gated')
       ON CONFLICT (run_id, tool_call_id) DO NOTHING
  6a. autonomy:
        invoke tool.execute(input)
        UPDATE row → status='executed' | 'failed', execute_result | execute_error, executed_at=now()
        return result to boss
  6b. gated:
        SSE poke kind='staging_pending' { stagingId, toolName, integration, riskTier }
        BullMQ delayed job 'staging-notify:<stagingId>' with delay = user_action_policies.approval_notify_delay_ms (default 5min)
        interrupt({ kind: 'hil', approvalId: stagingId, approvalKind: 'action_staging' })
```

Resume path (`signalRun({ runId, match: { kind: 'hil', approvalId: stagingId } })`):

```
load action_stagings row by stagingId
case status:
  'approved' → tool.execute(decided_input ?? proposed_input); update row; synth result (with editedByUser meta if edited)
  'rejected' → synth { status: 'rejected_by_user', toolName, proposedInput, reason, retryPolicy: 'do_not_retry_identical' }
  'expired'  → same shape as rejected, reason='auto-expired'
```

### 3c. Retry-suppression enforcement

A second `dispatchToolCall` with the same `(run_id, tool_name, hash(proposed_input))` as a previously rejected row synthesizes another `rejected_by_user` result **without** re-staging or re-emailing. Hash function lives in `@alfred/contracts` so the dispatcher and any tests agree.

### 3d. Run cancellation primitive

Add `cancelRun(runId, { reason })` beside `createRun` / `signalRun` in `packages/api/src/modules/agent/service.ts`. It must atomically set `status='cancelled'`, `ended_at`, `error.reason`, emit an `agent.run` terminal event, and be idempotent for already-terminal runs. The approvals API depends on this for "Reject and end run".

### Phase 3 acceptance

- End-to-end test: boss proposes `gmail.search` → autonomy → row in `action_stagings` with `status='executed'` and `execute_result` populated, tool result back to boss in milliseconds.
- End-to-end test: boss proposes `gmail.send_draft` → gated → row in `action_stagings` with `status='pending'`, run parked on `wakeCondition.kind='hil'`. Approve via direct DB update + `signalRun(...)`; run resumes; row transitions to `executed`.
- Retry-suppression test: reject a `gmail.send_draft` call, boss proposes the identical input again → second call synthesizes `rejected_by_user` without a new row.
- `cancelRun` test: calling it on a waiting run sets `status='cancelled'`; calling it again is a no-op.
- Open items resolved: `policy-bust` channel choice + SCAN-vs-index decision documented in the PR.

---

## Phase 4 — Agent bridge

Goal: replace the current registry-miss behavior for user-authored workflows with a real `AlfredAgent` loop driving the dispatcher. **Detailed design locked in [ADR-0040](../../decisions.md); this section captures the implementation slice.**

> Note: the "m12 stub" was scoped out before m12 shipped — pre-m13 `createRun` called `requireWorkflow` and threw on miss. Phase 4 doesn't delete a stub branch; it adds a checked resolver for run creation/execution that falls back to the sentinel workflow only after validating the user-authored workflow row exists and `is_builtin=false`.

### 4a. Schema + contracts

- **`agent_runs.transcript jsonb`** — new column typed `AgentTranscriptMessage[]` from `@alfred/contracts`, default `'[]'`, not null. One migration via `pnpm db:generate` → `db:migrate`. `@alfred/api` casts/converts this structural stored type to AI SDK `ModelMessage[]` only at the `AlfredAgent.turn()` boundary, so `@alfred/db` does not gain an `ai` dependency.
- **`@alfred/contracts` additions** — `parseIntegrationMentions(brief, allowedIntegrations)` (strict-seed parser) and the zero-dep `AgentTranscriptMessage` structural type.
- **Executor transcript plumbing** — load `agent_runs.transcript` with the leased run, expose it to step bodies, and let `StepResult` carry an optional replacement transcript that `commitStepSuccess` persists atomically with `state` / `current_step`. Built-ins that omit it leave the column unchanged.
- **System-tool context** — let `dispatch-tools` pass `state.allowedIntegrations` into `ToolExecuteContext` for `system.load_integration`, so the pure tool can return allowed/not-allowed without reading or mutating run state.
- **`RegisteredTool.description: string` required.** Backfill `gmail.search`, `gmail.send_draft`, `calendar.list_events`, `calendar.create_event`. Add `system.load_integration`.

### 4b. Sentinel workflow + executor steps

- **`userAuthoredBriefWorkflow`** at `packages/api/src/modules/agent/workflows/user-authored-brief.ts`. Slug `__user-authored-brief__`, never registered into the in-memory registry; the DB-backed resolver returns it on registry miss only for verified user-authored rows. `initialState({ brief, metadata })` parses `@`-mentions, sets `state.activeIntegrations`, `state.allowedIntegrations`, `state.pendingToolCalls`, `state.inFlightTailStart`, and `state.turnCount`; `initialTranscript({ brief })` seeds `agent_runs.transcript = [{ role: 'user', content: brief }]`.
- **`createRun` / executor existence check + slug preservation** — when the registry misses and falls through to the sentinel, validate `workflows (userId, slug)` exists AND `is_builtin=false` before serving the run. Typos and deleted builtins throw. Insert `agent_runs.workflow_slug = args.workflowSlug`, not `workflow.slug`, so the row still joins to the user-authored workflow instead of `__user-authored-brief__`.
- **Two named steps:**
  - `boss-turn` instantiates `AlfredAgent` (system = preamble, tools = `resolveSdkTools(state.activeIntegrations)`, model = `getBossModel()`), runs one `turn()` with the leased transcript, sets `state.inFlightTailStart` to the pre-append transcript length, increments `state.turnCount`, and returns `next: 'dispatch-tools'` / `done` / `stopped`-mapped plus the transcript with assistant messages appended.
  - `dispatch-tools` consumes `state.pendingToolCalls` from the front, calls `dispatchToolCall` for each, appends tool-result messages to the transcript column, applies system-tool effects (`system.load_integration` → `state.activeIntegrations` append). After each non-staged result, remove that call from `pendingToolCalls`; the first `kind: 'staged'` short-circuits with `interrupt`, preserving the transcript produced so far and leaving the staged/current call plus remaining calls for resume.
- **Turn cap** — 30. Exceeded → fail the run with `error.message = 'turn_limit_exceeded'`.

### 4c. `system.load_integration` tool + dispatcher autonomy override

- Register `system.load_integration` via `liveTool` with an API-local zod schema derived from `INTEGRATION_SLUGS` that rejects `system`, pure `execute` returning `{ ok: true, slug }` or `{ ok: false, status: 'not_allowed', slug }` based on the allowlist passed in context.
- **Dispatcher autonomy override** in `dispatchToolCall`: `if (integration === 'system') policyMode = 'autonomy'` ahead of `resolvePolicyMode`. Audit row still lands.
- State mutation lives in the `dispatch-tools` step body (the small switch on `toolName`), never inside the tool's `execute`.

### 4d. Boss system prompt

Preamble lives beside the sentinel workflow in `packages/api/src/modules/agent/workflows/user-authored-brief.ts` until a second boss workflow needs it factored out. Shape: Anthropic 10-section template (sections 1, 2, 4, 5, 8, 9 in cache-stable `system`; brief flows as first user message). User-stable preamble; no run ids, timestamps, or `activeIntegrations` narration in the system block.

### 4e. Smoke

`apps/server/src/scripts/smokes/smoke-brief-execution.ts` — auto-approves any pending `action_stagings` via direct DB update + `signalRun()`, exercising both autonomous and gated-resume paths. Lives in `apps/server/src/scripts/` alongside the other smokes (`smoke-cold-start`, `smoke-sub-agents`, etc.) rather than under `packages/api/` because it depends on the running server worker. Brief: `"@gmail — Read my most recent inbox email and summarize it in one sentence. Then tell me what's on my calendar tomorrow morning."` Asserts: status=completed, ≥ 2 ping-pong step rows each, `system.load_integration` + `gmail.*` + `calendar.*` executed stagings, `state.activeIntegrations` grew, `api_call_log` count = `boss-turn` count, output text non-empty.

### Phase 4 acceptance

- A user-authored brief-only workflow with `@gmail` in the brief executes end-to-end against a real Gmail account, producing one or more `agent_runs` rows that reach `status='completed'`.
- `system.load_integration('calendar')` mid-run adds `calendar.*` tools to the next turn's tool list.
- Registry misses fall back to the sentinel only through the checked run resolver; `requireWorkflow` remains strict for registered-code lookup; deleted-builtin slugs throw loud.

---

## Phase 5 — HIL surface (web)

Goal: humans approve, edit, or reject staged actions inside the app, with email as the slower backstop.

### 5a. SSE + Replicache wiring

- Add event schemas for `staging_pending` and `staging_resolved` in `packages/api/src/events/types.ts`, or intentionally reuse/replace the existing `approval.requested` event. The implementation must leave one canonical browser event for a pending approval; avoid emitting both for the same staging row.
- **Implementation choice:** reuse `approval.requested` as the canonical pending-approval event (`approvalKind='action_staging'`). Replicache carries the durable `/approvals` queue; do not emit a separate `staging_pending` event for the same row.
- Add `actionStagings` to `IDB_KEY`, `packages/sync/src/types.ts`, and `ENTITY_FETCHERS` per the Replicache add-an-entity recipe in `CLAUDE.md`. Pull filters to `user_id = current_user AND status = 'pending'`. Every insert/update that changes a synced field must bump `action_stagings.row_version`.

### 5b. `/approvals` page

- Replicache-synced list sorted by `created_at` desc; nav badge counter.
- Per-tool card components live in `apps/web` in a web-only registry keyed by `ToolName`. Do not import runtime values from `@alfred/api` into the web bundle. Generic JSON renderer fallback for tools without a custom card.
- Each card: tool name + risk-tier badge, provenance link to run + workflow, editable proposed-input fields, four actions: **Approve**, **Approve with edits**, **Reject (required reason)**, **Reject and end run**.
- Banner showing the most recent prior rejection of the same `(user_id, tool_name)` within N days, if one exists.

### 5c. Decision API

`POST /approvals/:stagingId/decision` with `{ decision: 'approve' | 'reject' | 'cancel_run', editedInput?, reason? }`. The handler:

- UPDATE `action_stagings` row.
- Remove the `staging-notify:<stagingId>` delayed job if still queued.
- `signalRun({ runId, match: { kind: 'hil', approvalId: stagingId } })`.
- For `cancel_run`: call `cancelRun(runId, { reason: 'cancelled_by_user' })`.

### 5d. Email debounce worker

BullMQ worker on the `staging-notify` queue. On job fire:

- Re-read the `action_stagings` row. If `status !== 'pending'`, no-op.
- Render subject/html/text and call the existing `notify({ userId, kind: 'approval', idempotencyKey: 'approval:' + stagingId, ... })` helper. `notify` does not accept a positional `(userId, kind, payload)` signature in code today.
- UPDATE `notified_at = now()` for audit.

Subject: `[<risk_tier>] Alfred wants to <humanized tool name>`. Body includes key fields + deep link to the in-app card.

### 5e. Approval expiry worker — **KEPT** (decided 2026-05-29)

`expires_at` stays. The dispatcher sets it on every gated `action_stagings` insert to `now + APPROVAL_EXPIRY_MS` (fixed 24h window in `@alfred/contracts`; ADR-0034's "per-tool default" deferred until a product need appears) and schedules a delayed `staging-expire:<stagingId>` job mirroring `staging-notify`. On fire, the worker re-reads the row; if still `pending`, it `signalRun`s the parked run, marks `status='expired'`, sets `reject_reason='auto-expired'`, and bumps `row_version` so Replicache drops the card. Resolution rides the existing `approval.requested`/Replicache-pull pattern (5a choice) — no separate `staging_resolved` event. The dispatcher's existing `case 'expired'` synthesizes the structured auto-expired rejection back to the boss on resume. The decision API removes the queued expiry job when a human acts first.

Files: scheduling in `packages/api/src/modules/approvals/expiry-queue.ts` (agent-free, imported by the dispatcher), worker in `expiry-worker.ts` (imports `../agent`, started at boot). No migration — `expires_at` already shipped in migration 0017. Proven by `apps/server/src/scripts/smokes/smoke-expiry.ts` (drives `expireStaging` directly rather than waiting 24h): staging sets `expires_at` + queues the job; expiry flips the row + wakes the run; re-dispatch synthesizes the auto-expired rejection without executing; human-decided rows and dequeued jobs both no-op.

### 5f. Approvals UI polish (design grilled 2026-05-31, then `/make-interfaces-feel-better`)

Phase 5 core is shipped + QA'd; this is the communicate-clearly + feel-better pass on the `/approvals` card and page. All decisions below are locked. Glossary updated (`Action staging` card-provenance projection; `Approvals surfaces`). Two-surfaces boundary captured in the **ADR-0034 amendment (2026-05-31, "approvals read models")** — landed.

- **Provenance enrichment (data, no migration).** The `ACTION_STAGING` Replicache fetcher (`packages/api/src/modules/replicache/entities.ts`) adds three derived, read-only fields per row: `workflowName` (join `workflows` on `(userId, slug)`, fall back to slug for deleted builtins), a **narrowed display-only `trigger`** projection `{ kind, source?, type? }` (from `agent_runs.trigger` — never the raw payload/doc ids), and a server-truncated `brief` (~280 chars, from `agent_runs.brief`). Extend `syncedActionStagingSchema` (`packages/sync/src/schemas.ts`) accordingly. Derived-on-pull, so no `row_version` bump.
- **Shared humanizer.** Promote `humanizeToolName(toolName)` into **`@alfred/contracts`** (zero-dep) as the single source; both the email worker (`notification-queue.ts`) and the web card consume it. Kills the two-copies drift risk.
- **Card-spec registry.** Widen the existing web-only `Partial<Record<ToolName, …>>` in `input-renderer.tsx` from a bare field-builder into `ApprovalCardSpec = { title(input): string; fields(input): Field[] }`. Generic fallback = contracts `humanizeToolName` title + raw-JSON body. Type-safe keys from `ToolName`; unmapped tools render safely. The card body is per-(integration, action); **the four decision actions stay uniform** (not per-tool).
- **Provider icon.** Swap the generic Lucide `ToolIcon` for the real brand `IntegrationIcon` (`~/lib/integration-icons`) via an `IntegrationSlug → IntegrationBrand` map; `system` keeps a glyph fallback.
- **Card header.** Lead with the humanized action title (input-aware where the card spec adds clarity, e.g. "Email yashgouravkar@gmail.com") + provider brand icon + risk badge; demote raw `ToolName` to a mono chip. Provenance line: workflow display name + trigger ("Run now" vs "Triggered by Gmail message") + brief preview + run id + timestamp. **No run↔chat schema link** (deferred).
- **Interaction density / tiered actions.** Default scan state shows icon, title, risk badge, provenance, read-only structured fields, and primary **Approve** + secondary **Reject**. **Edit** is progressive disclosure that reveals the raw-JSON editor (v1 edit mechanism; structured editable fields are a future per-card enhancement) and flips the primary button to **Approve with edits** (same button, not a fifth). **Reject** reveals/focuses the required-reason input inline. **Reject and end run** is de-emphasized (quiet/destructive overflow), not a peer button.
- **Filter + window (client-side).** Facets **integration + risk**, multi-select chips, **OR-within / AND-across**. Only surface facet values present in the queue, with counts; recompute as the synced set changes. Filter state in **URL search params** (TanStack Router). "Pagination" = windowing/virtualization over the bounded synced set — **no server query endpoint** for the live queue. Two empty states: "No pending approvals" vs "No approvals match these filters" + **Clear filters**. The `N pending` badge stays the true total; filtered view shows "showing X of N".
- **History (deferred).** Resolved actions (approved/rejected/expired) are a separate **server-paginated + filterable** read model, built when the History tab lands. Not in this pass.

### Phase 5 acceptance

- Gated `gmail.send_draft` arrives in `/approvals` within seconds of dispatch.
- Approving in-app within 5 minutes never sends an email (job removed).
- Letting the timer fire sends exactly one email; `notified_at` populated.
- Rejecting with "Reject and end run" cancels the run with `reason='cancelled_by_user'`.
- Pending approvals disappear from `/approvals` after approve/reject/expire because `row_version` bumped and Replicache pulled the delete.

---

## Phase 6 — Sub-agents

Goal: the boss can spawn one level of sub-agents (ADR-0016) that write findings into the scratchpad.

### 6a. Spawn primitive

`spawnSubAgent({ parentRunId, brief, subId, allowedIntegrations })`:

- Insert child `agent_runs` row with the sub-agent brief as the first transcript message (ADR-0026 "sub-agent brief").
- Child run shares the dispatcher; its tool calls produce `action_stagings` rows owned by the parent's user but tagged via `run_id`.
- One level deep only (no sub-sub-agents per ADR-0016).

### 6b. Scratchpad zone enforcement

Inside `dispatchToolCall`, when handling `write_scratch`:

- If caller is `sub_a`, key must match `scratch.sub_a.*`. Reject otherwise.
- If caller is the boss, key must match `shared.*`. Reject `scratch.*` writes from the boss.

### 6c. Scratchpad tools

Register `read_scratch`, `write_scratch`, `promote` as built-in tools (alongside `load_integration`). Risk tier `no_risk` — never gated. `promote` is boss-only and enforced at dispatch time.

### 6d. Sub-agent fail-back-to-boss

If a sub-agent's transcript crosses the compaction threshold (Phase 7), the sub-agent's run fails with `reason='context_pressure_in_subagent'` (ADR-0026 / ADR-0035 — sub-agents do not compact). The boss receives the failure as a tool result and re-decomposes.

### Phase 6 acceptance

- Spawn a sub-agent that writes `scratch.sub_a.findings` → boss reads it via `read_scratch` → boss calls `promote('scratch.sub_a.findings', 'shared.findings')` → terminal snapshot lands both keys in `agent_run_context`.
- Attempting to write `shared.*` from a sub-agent (or `scratch.sub_a.*` from the boss) is rejected at dispatch.
- A sub-agent forced past 60% context window fails back to the boss; no compactor call is made inside the sub-agent.

---

## Phase 7 — Transcript compaction (ADR-0035)

Goal: long boss runs maintain quality by compressing older transcript into a structured XML handoff.

### 7a. Token counting + threshold check

After every `dispatch-tools` step, the executor calls `tokenCount(agent_runs.transcript)` (AI SDK tokenizer; `@anthropic-ai/tokenizer` for Anthropic models — within ~5% is fine). If the count exceeds `compactionThresholdTokens(Math.min(bossWindow, compactorWindow))`, schedule a `compact-transcript` step before the next `boss-turn`.

Both windows read from the `model_prices.context_window` column — `bossWindow` from `getBossModel()`, `compactorWindow` from `COMPACTOR_MODEL`. The threshold uses the **smaller** of the two so the prior slice handed to the compactor never exceeds what the compactor can ingest (see the ADR-0035 amendment 2026-06-01 — this matters *now*: boss is `gemini-2.5-pro` 1M, compactor is Sonnet 200k). The same `min()` threshold is used at the post-compaction overflow guard, not the boss window alone.

### 7b. In-flight tail identification

Use `state.inFlightTailStart`, captured by the last `boss-turn`, as the boundary. Preserve `agent_runs.transcript.slice(state.inFlightTailStart)` verbatim. Everything before is fed to the compactor; everything after stays as-is.

### 7c. Compactor invocation

**Ownership boundary (so the primitive is safe to reuse).** `compactTranscript(...)` — the reusable primitive (CONTEXT.md "Transcript compaction") — **owns model selection and prior-window enforcement**: it resolves `compactorWindow`/`fallbackWindow` from the constants itself, picks primary-vs-fallback, and throws `compactor_input_too_large`. The caller (`userAuthoredBriefWorkflow`) **owns only the threshold trip-wire math** — when to *schedule* a `compact-transcript` step — and supplies `{ prior, inFlightTail, attribution }`. This keeps the guard out of the caller so the future chat surface can call the primitive without re-implementing (or forgetting) the policy. The trip-wire reads the compactor window via the exported `COMPACTOR_MODEL` constant; it does not duplicate the selection logic.

The selection + guard live **inside** `compactTranscript`:

```ts
// inside compactTranscript({ prior, inFlightTail, attribution }):
const compactorWindow = await resolveModelContextWindow(COMPACTOR_MODEL);
const fallbackWindow = await resolveModelContextWindow(COMPACTOR_FALLBACK_MODEL);
const priorTokens = tokenCount(prior);
let model = COMPACTOR_MODEL;                        // Sonnet 4.6, thinking off
if (priorTokens > compactorWindow) {
  if (priorTokens <= fallbackWindow) model = COMPACTOR_FALLBACK_MODEL; // Gemini 2.5 Flash, 1M
  else throw new Error('compactor_input_too_large');
}

const result = await meteredGenerateText({
  model,
  temperature: 0,                                  // extract, don't generate
  attribution: { kind: 'llm', role: 'compactor' },
  maxOutputTokens: 2000,
  system: COMPACTOR_SYSTEM_PROMPT,
  messages: prior,
});
return { transcript: [summaryMessage(result.text), ...inFlightTail], /* … */ };
```

`COMPACTOR_MODEL` / `COMPACTOR_FALLBACK_MODEL` are shared constants (not a `getCompactorModel()` tier dispatcher), imported by both this call and the threshold math in 7a (which needs `compactorWindow`). Sonnet runs with extended thinking **disabled** (`providerOptions.anthropic.thinking: { type: 'disabled' }`) — the compactor is a mechanical transform, not a reasoning task.

`COMPACTOR_SYSTEM_PROMPT` enforces: 2000-token cap, drop verbatim text, keep IDs + decisions + every approved/rejected/failed action with outcome + every sub-agent finding, **preserve mid-run user intent statements verbatim under `<user_directives>` — do not paraphrase**. Each `<action>` is one short line.

XML schema sections (per ADR-0035): `goal`, `user_directives`, `decisions`, `actions_completed`, `actions_rejected`, `actions_failed`, `sub_agent_findings`, `pending_followups`, `key_entities`.

### 7d. Cache breakpoint

Place a third ephemeral `cacheControl` breakpoint immediately after the `<run_summary>` system note (ADR-0026 reserved this slot for compaction). The system message + last tool definition breakpoints from ADR-0026 are unchanged.

### 7e. Fault behavior

Two distinct fault paths, do not conflate them:

- **Compactor *call* failure** (model error / invalid envelope) → bounded in-step retry (3 attempts, 100ms then 200ms backoff) then the run fails with `reason='compactor_failed: <msg>'`. Running with overflowing context = hallucination / silent truncation, so explicit failure beats degraded output. (Already shipped.)
- **Prior slice doesn't fit the compactor window** → *not* a failure first. Fall over to `COMPACTOR_FALLBACK_MODEL` (Gemini 2.5 Flash, 1M window); only if the slice exceeds even the fallback window does the run fail with `reason='compactor_input_too_large'`. This is the one place a degraded (lower-quality) compaction is accepted — surviving a pathological high-payload turn beats killing the run. See the ADR-0035 amendment.

### 7f. Prompt engineering pass

Budget real time. ADR-0035 marks the prompt as "sketched, not engineered" — run long workflows in staging, inspect handoff outputs, tighten the prompt until directives and decisions consistently survive a compaction round-trip.

**Design locked (grill-with-docs 2026-06-01):**

- **Done-bar = strengthened fixture suite, staging is a final spot-check** (not the iteration loop — staging runs are ~35-40 min and compaction only fires past threshold, a terrible loop). "Consistently" = each fixture passes a flakiness gate (run N times, all green; N TBD in the next branch).
- **Model decoupled to Sonnet 4.6 (thinking off), fallback Gemini 2.5 Flash, `min(boss,compactor)` threshold + prior-fits guard.** Full rationale in the **ADR-0035 amendment (2026-06-01)**. Tune the prompt against Sonnet, not flash-lite.
- **Assertions: section-scoped with negatives.** Fixture schema moves from `mustContain: string[]` to `assertions: [{ section, contains | absent }]` — extract the named `<section>` block (tolerant regex, no XML-parser dep) and assert the needle is inside it; negatives assert it is *absent* from the wrong section.
- **Fixtures: the existing three + three new (six total):** `directive-vs-decision-boundary` (both a directive and a fact present; each in its correct section, absent from the other), `superseded-directive` (both directives retained verbatim in chronological order; the later override appears in `<user_directives>` **without** a superseded marker, the earlier conflicting one appears **with** `superseded="true"` — assert both, plus a negative that the override is *not* marked superseded), `under-pressure-completeness` (transcript large enough that the 2000-token cap actually binds; all actions + directive still survive). Plus **fold ID-survival assertions into the completeness fixtures** (specific thread/message ids must reach `key_entities` or an action `key_output`) — no dedicated file.
- **Flakiness gate: compactor at temperature 0, N=5 runs per fixture, all-green bar.** Temp 0 because the compactor extracts, it doesn't generate — improves fidelity and shrinks eval variance. All-green (not majority): a 1-in-5 flake on a load-bearing assertion is the prompt-robustness signal 7f exists to surface, not test noise to tolerate. ~30 cheap calls/suite.
- **CI split:** `smoke-compaction.ts` stays a **manual/periodic** smoke (real Sonnet calls — matches every other smoke; keeps live-model cost/keys/flake out of CI) and is the 7f sign-off gate. A **separate pure unit test in CI** (no model) guards the contract: `COMPACTOR_SYSTEM_PROMPT` contains all 9 schema section tags + the section-extraction helper scopes a recorded sample correctly. Catches the silent section-rename regression `prompt.ts` warns about, for free.
- **Section-extraction helper has one home:** `extractHandoffSection(runSummaryXml, section): string | null` (+ a thin `assertHandoffSections` for the contract test) lives at `packages/api/src/modules/agent/compaction/handoff.ts` and is **imported by both** `smoke-compaction.ts` and the CI unit test — the regex is written once, never duplicated across script and test.
- **Prompt approach: pre-emptive.** Harden `COMPACTOR_SYSTEM_PROMPT` against all four known weak spots up front, then baseline the suite to see what's left — rather than baselining the current draft first. The four targets: (1) **superseded directives** — instruct: keep every directive verbatim in chronological order, and when a later directive conflicts with / revokes an earlier one, tag the earlier `<directive superseded="true">`. Both survive; only the marker disambiguates currency. (Current "preserve every directive verbatim" keeps both with no current-vs-stale signal, so the boss can act on revoked permission.) (2) **directive/decision boundary** — more than one example each, sharper pragmatic-vs-epistemic test; (3) **drop-priority under the 2000-token cap** — explicit cut-order making `<user_directives>` + action records never-drop, narrative/entity-context first to go; (4) **ID survival** — tie "every actionable ID lands in `key_entities`" firmly, not just a general "keep IDs."

**Build sequence:** decouple model (`COMPACTOR_MODEL` + `COMPACTOR_FALLBACK_MODEL` consts, temp 0, thinking off) → retarget `verifyMeteringModels` to assert `context_window` rows for **both** new constants (drop the now-wrong "cheap = compactor" justification; keep the `cheap` check only if triage/extraction still uses it) → confirm `db:sync-prices` populates `context_window` for Sonnet 4.6 + Gemini 2.5 Flash → move model-selection + prior-fits guard + fallback escalation **into** `compactTranscript` (the primitive owns it; resolves both windows from the constants) → `min()` threshold trip-wire at both workflow sites (reads `compactorWindow` via `COMPACTOR_MODEL`, does not duplicate selection) → `handoff.ts` section-extraction helper → restructure the harness for section-scoped assertions + N=5 + temp 0 → write the 3 new fixtures + fold ID assertions → pre-harden the prompt → baseline run → iterate to all-green → CI unit test → staging spot-check.

**Deferred from the 7f eval pass (revisit later):**

- **Dedicated `pending_followups` fixture** — lower value than the directive/action/ID survival cases; the boss usually re-derives next-steps from the surviving state. Add if staging shows the boss losing its thread across a compaction.
- **Full XML-parse validation** of the handoff — chose section-scoped regex for v1 (zero-dep, catches the misclassification failure mode). Revisit if a downstream audit/replay surface starts consuming the handoff structurally (the ADR already flags this as the eventual consumer).
- **2000-token output cap tuning** — still ADR-0035's "v1 guess." The `under-pressure-completeness` fixture will expose whether it's too tight; dial then, not now.
- **Boss-system-prompt "restate intent as future-compaction-friendly directives" guidance** (ADR-0035 Open item, slated for m13a boss-prompt design) — complements compactor-side preservation but is out of 7f's scope.

### Phase 7 acceptance

- A run with a manually inflated transcript hits the threshold, runs `compact-transcript`, and continues with the new `agent_runs.transcript` shape `[<run_summary>, in-flight tail]`. The stable boss system prompt and tool definitions remain outside the transcript as `AlfredAgent.turn()` inputs.
- `<user_directives>` content is preserved verbatim (not paraphrased) across a compaction.
- One `api_call_log` row per compaction with `attribution.role='compactor'` — and the metered model is `COMPACTOR_MODEL` (or `COMPACTOR_FALLBACK_MODEL` on the overflow path), not `getCheapModel()`.
- Compactor *call* failure surfaces as a real run failure (`compactor_failed`), not silent quality loss.

New acceptance for the amended (2026-06-01) design — these prove the risky parts, not just generic compaction:

- **`min()` threshold:** with boss window > compactor window (the live `gemini-2.5-pro` 1M / Sonnet 200k case), compaction triggers at `60% × compactorWindow` (≈120k), **not** `60% × bossWindow` (≈600k). Assert the trip-wire fires at the smaller bound.
- **Overflow fallback:** a `prior` slice larger than `compactorWindow` but within the fallback window routes to `COMPACTOR_FALLBACK_MODEL` and completes — the metered row shows the Flash model, the run does not fail.
- **`compactor_input_too_large`:** a `prior` slice larger than even the fallback window fails the run with that reason (no silent truncation).
- **Post-compaction overflow guard uses `min()`:** Guard 3 thresholds on `min(boss, compactor)`, so a large in-flight tail that would pass under the boss window is caught.
- **`verifyMeteringModels` boot guard** fails loudly if either `COMPACTOR_MODEL` or `COMPACTOR_FALLBACK_MODEL` lacks a `model_prices.context_window` row.

---

## Phase 8 — Other dispatchers + policy UX

Goal: light up the `event` trigger kind and ship the policy editing surface. **Scope locked in grilling 2026-05-29 → ADR-0047; `on_signal` (8b) deferred** (no signal producer exists in the codebase, so a dispatcher would be untestable dead code).

### 8a. `event` trigger dispatcher — the `emitEvent` bus (ADR-0047)

Generic bus, **one dispatch path**, triage unified onto it. Detailed design in [ADR-0047](../../decisions.md).

- **`emitEvent({ userId, source, type, eventId, payload })`** in `packages/api/src/modules/workflows/` (or a new `modules/event-dispatch/`, not `modules/events/` because that already means realtime outbox/SSE): queries `workflows WHERE status='active' AND trigger->>'kind'='event' AND trigger->>'source'=… AND trigger->>'type'=…`, `createRun`s each match with uniform `input: { documentId, reason, source, type }` + `trigger: { kind:'event', source, type, eventId, payload: { documentId, reason } }`.
- **Triage unification:** delete `enqueueTriageRuns`' hardcoded `createRun` (`packages/api/src/modules/integrations/queue.ts`); the Gmail ingestion worker calls `emitEvent` per freshly-inserted doc instead. `email-triage`'s row already has `trigger.kind='event'`; migrate its `source/type` to `gmail`/`message_received`. `initialState` reads `input.documentId/reason` **unchanged** — run behavior byte-identical.
- **`@alfred/contracts`:** add closed `EVENT_SOURCES` (`['gmail']`) + per-source `*_EVENT_TYPES` (`gmail: ['message_received']`); migrate the `workflowTrigger` event schema from open `source: string` to `{ source: EventSource, type: EventType, filter? }`. v1 dispatcher does **not** evaluate `filter`; API rejects non-empty `filter` writes.
- **Run trigger schema:** migrate `agentRunTriggerSchema`'s event branch to tolerate old rows and require new writes. Historical rows are `{ kind:'event', eventId, payload }`, so either make `source/type` optional on read or backfill. Prefer tolerant read: `source?: EventSource`, `type?: EventType`; new `emitEvent` writes always include both.
- **Payload resolve-at-init:** `trigger.payload = { documentId, reason }` only. Widen `WorkflowInput` to include `userId` and `trigger`; `Workflow.initialTranscript` returns `MaybePromise`; `createRun()` awaits it. The sentinel reads `documents WHERE user_id = input.userId AND id = trigger.payload.documentId` to append a `user`-role `<trigger_event>` message after the brief.
- **Missing document fallback:** if the referenced document is gone, append `<trigger_event unavailable="true" document_id="...">` and continue; do not throw from `createRun`.
- **Bounded `<trigger_event>` context:** for inbound provider content, include ids, source/type, title/subject, sender metadata, authored time, URL, and a raw excerpt capped at **4,000 characters** for v1; include `truncated=true` + `documentId` when clipped. Do **not** inline full third-party bodies by default. User-authored outbound content may be inlined in full when Alfred created it.
- **Register the read escape hatch:** add an executable `gmail.read_message` `liveTool` in `packages/api/src/modules/tools/gmail.ts` before relying on the bounded excerpt. `GMAIL_ACTIONS` already includes `read_message`, but callability comes from the registry. Input should accept `documentId` (preferred) or Gmail message id; output may return full cached `documents.content` plus metadata, still subject to dispatcher policy.
- **Auto-seed:** event runs seed the trigger source's integration into `state.activeIntegrations` (∩ `workflows.allowed_integrations`).
- **Allowed-integration validation:** when creating/updating an event workflow, reject `allowed_integrations` if it is non-empty and does not include `trigger.source`; otherwise the workflow cannot act on its own trigger and `system.load_integration` will also fail the cap.
- **Event authoring:** re-enable the event trigger branch in the workflow editor with source/type pickers and an empty-filter-only API contract. Keep `on_signal` disabled.
- **Idempotency:** bounded, not global. Keep insert-once → emit-once + webhook 30s dedup. Add a best-effort non-terminal duplicate check in `emitEvent` on `(userId, workflowSlug, source, type, eventId, reason)` before `createRun` so ingestion job retries do not normally double-fire. This is racy by design without a DB constraint; do **not** add a hard `(user_id, workflow_slug, eventId)` index because it would break triage's reply-retriage. `eventId` is audit/filter only.

### 8b. `on_signal` trigger dispatcher — **DEFERRED**

No code emits a named signal today (the glossary's `cold-start.ready` is illustrative). Building a subscriber for a non-existent producer ships untestable dead code. Revisit when a concrete signal producer lands. The m12 UI tooltip for `on_signal` stays "lands later."

### 8c. Per-integration policy editor — Replicache-synced (ADR-0034 amendment)

On the `/integrations/$provider` detail page:

- Radio: **Full autonomy** / **Gated**. (Per-tool overrides + `default_mode` editing deferred from the v1 UI.)
- **Migration:** add `row_version` (+ bump) to `user_action_policies`. Wire it through the Replicache add-an-entity recipe (`IDB_KEY`, `packages/sync/src/types.ts`, `ENTITY_FETCHERS`) as a **single entity keyed by `userId`**; the web derives each integration's mode from `integration_rules[slug].mode ?? default_mode` client-side. Pull filters to `user_id = current_user`.
- **Mutation dual-invalidates:** UPDATE `user_action_policies.integration_rules`, bump `row_version` (web pull), **and** `publishPolicyBust(userId)` (in-process dispatcher cache across instances).

### 8d. Risk-tier UX polish

- **Tier counts folded into the integrations-resolve endpoint** (the detail page already calls it) — per-integration `{ high, medium, low, no_risk }` from `listToolsForIntegration(slug)`, server-side (web can't import the registry). Renders "Gmail — 12 tools (4 high, 5 medium, 3 low)".
- Staging-card badges reflect `riskTier`.
- Email subject prefix `[<risk_tier>]`.

### Phase 8 acceptance

- An `event`-triggered user workflow fires on a real Gmail message event through `emitEvent`, with a `<trigger_event>` message carrying bounded email context and a `documentId`; `smoke-triage` still passes (triage rides the same bus).
- Toggling Gmail from `gated` to `autonomy` in the UI takes effect on the next dispatched tool call across all server instances (policy cache bust) AND the change reflects on other devices via Replicache.

---

## Phase 9 — Smoke

Goal: prove the whole milestone works as a single feature.

End-to-end smoke script (analogous to `smoke-triage.ts`, `smoke-briefing.ts`, `smoke-cold-start.ts`):

`smoke-boss.ts`:

1. Create a user-authored brief-only workflow with `@gmail` and a brief that requires (a) a search, (b) a sub-agent spawn to inspect threads, (c) a draft email send.
2. Trigger via "Run now".
3. Assert: `gmail.search` lands as autonomy (executes immediately). Sub-agent spawn lands; `scratch.sub_a.findings` populates; boss promotes to `shared.*`. `gmail.send_draft` lands as gated (status='pending').
4. Approve the draft via the API.
5. Run reaches `status='completed'`. `agent_run_context` mirrors both scratchpad keys. No `compactor_failed` runs.

Run on a dev account; capture the smoke output in the milestone PR description.

### Phase 9 acceptance

- `pnpm smoke-boss` completes green against a real dev Gmail account.

---

## Deferred follow-ups

### Unify integration / action / scope constants in `@alfred/contracts` (future cleanup)

Surfaced while grilling the Phase 5 approvals-UI polish (2026-05-31). Today `INTEGRATION_SLUGS`, `INTEGRATION_ACTIONS`, and the derived `ToolName` type already live in `@alfred/contracts` and are the single source the dispatcher, schemas, and the web card registry build from. **OAuth scope constants do not** — `GOOGLE_FEATURE_SCOPES` and the per-feature scope mappings live server-side in the integrations module (see ADR-0044's least-privilege scope tiers). The cleanup: make per-integration scope/feature metadata derive from the same contracts constants so scope types, action lists, and integration slugs can't drift, and so any surface (card registry, policy editor, integration detail page) reads one canonical map.

**Why it's only a note, not yet scheduled work:** there's a real boundary tension to resolve first — `@alfred/contracts` is zero-dep and web-importable, but *which scopes we request per feature* is arguably server-side OAuth policy, not a web-safe constant. Deciding how much of the scope model belongs in contracts vs. stays server-only is a genuine trade-off with downstream consequences. **If/when tackled, this graduates to its own ADR** (it touches the ADR-0044 scope posture); until then it stays a flagged follow-up. Does not block any m13 phase — the approvals card registry is already type-safe via `ToolName`.

### Surface "gated gates reads too" in onboarding / integration UX copy (Phase 8 grilling, 2026-05-31)

Decided during the Phase 8 grill: under a `gated` integration policy there is **no read/write split and no trigger-doc carve-out** — even `gmail.read_message` (reading past the inline 4k `<trigger_event>` excerpt of the very email that fired a run) stages for approval (alt (a); the trigger-doc pre-authorization alt (c) was rejected as a bespoke policy concept that per-tool overrides will subsume). This is correct behavior but **mildly surprising**, so it must be communicated where the user opts into gating: **credential-consent copy during onboarding** and/or the **`/integrations/$provider` detail page** when the autonomy/gated radio (Phase 8c) lands. One line is enough — e.g. "Gated means Alfred pauses for your approval before *any* action on this integration, including reading messages beyond a short preview." Pairs naturally with the Phase 8d risk-tier copy on the same surface. Glossary updated (`Policy mode`). Not a code blocker; it's a copy obligation owed by whichever of {onboarding credential step, Phase 8c policy editor} ships first.

**RESOLVED 2026-06-01:** the Phase 8c policy editor shipped first carrying this line — `provider-policy.tsx:79` renders "Alfred pauses for your approval before any action on {provider}, including reading messages beyond a short preview." in the gated state. Obligation met; the onboarding credential step inherits the copy if/when it wants it but no longer owes it.

## Status board (update inline as work lands)

- [x] **Phase 1** — Foundations: contracts package, migrations, signup hook
- [x] **Phase 2** — Runtime primitives: scratchpad helpers, tool registry, initial tool slice
- [x] **Phase 3** — Dispatcher (the spine) — open ADR items resolved
- [x] **Phase 4** — Agent bridge: ping-pong `boss-turn` ↔ `dispatch-tools` steps + sentinel `userAuthoredBriefWorkflow` + `agent_runs.transcript` jsonb + `system.load_integration` + strict `@`-mention seed (ADR-0040). Smoke at `apps/server/src/scripts/smokes/smoke-brief-execution.ts`.
- [x] **Phase 5** — HIL surface. Server `ACTION_STAGING` pull fetcher (5a-server), `useActionStagings` Replicache hook + live `/approvals` page wired to the decision API (5a-web/5b), `POST /api/approvals/:stagingId/decision` (5c), `staging-notify` debounce worker scheduled from the dispatcher + started at boot (5d), and the `staging-expire` worker (5e — **kept**; dispatcher sets `expires_at` + schedules the job, worker flips `pending`→`expired` and signals the run, decision API cancels the job; proven by `smoke-expiry.ts`). Manual QA done 2026-05-31: drove real gated `gmail.send_draft` runs and clicked through `/approvals` in the browser — Reject (→ rejected row + reason + `row_version` bump → Replicache delete → run resumes → boss completes) and Approve (→ execute → `failed`/`execute_error` → delete → resume → completes) verified live; prior-rejection banner, risk-tier badge, custom send-draft card, provenance link, and reason/edit button-gating all verified; Approve-with-edits (`decided_input`) and Reject-and-end-run (`cancelRunInTx`) are code-verified through the same `onDecide`→decision-API pipeline. **Note (resolved 2026-05-31):** `gmail.send_draft.execute` now performs a real Gmail send (`sendMessage` in `@alfred/integrations/google`, wired during Phase 9); the earlier-QA'd Approve path that resolved `failed` against the throwing stub now actually delivers the message. QA helper: `apps/server/src/scripts/qa/qa-gated-staging.ts` parks one gated staging without auto-approving. **5f (approvals UI polish)** designed 2026-05-31 (grill-with-docs) and **built + verified live 2026-05-31**: parked a real gated `gmail.send_draft` via `qa-gated-staging.ts` and confirmed in-browser the input-aware humanized title, Gmail brand icon, `high` risk badge, provenance line (workflow name + "Run now" trigger + run id + relative timestamp), demoted mono `ToolName` chip, brief preview, custom send-draft card spec (TO/CC/SUBJECT/THREAD/BODY), and tiered actions (Approve / Reject-with-required-reason / Edit→JSON disclosure / de-emphasized Reject & end run). `humanizeToolName` now lives in `@alfred/contracts`; provenance fields derived in the `ACTION_STAGING` fetcher. ADR-0034 amendment for the two-surfaces boundary **landed** (decisions.md, "approvals read models", 2026-05-31).
- [x] **Phase 6** — Sub-agents: spawn (`spawnSubAgent`), zone enforcement at the dispatcher, scratchpad tools (`system.read_scratch` / `system.write_scratch` / `system.promote`), and fail-back via `scratch.{subId}.error` (the latter closes alongside Phase 7's threshold infra).
- [x] **Phase 7** — Compaction: `lastInputTokens` token accounting, in-flight tail via `state.inFlightTailStart`, `compactTranscript` primitive at `packages/api/src/modules/agent/compaction/`, ephemeral `cacheControl` on the `<run_summary>` system message, `CallRole` plumbing with `'compactor'` wired, boot-time `verifyMeteringModels`, ADR-0046 stub for the future per-run cost ceiling. Fixture smoke at `apps/server/src/scripts/smokes/smoke-compaction.ts`; 7f prompt pass still owed.
- [x] **Phase 8** — **complete** (backend bus + all user-facing surfaces shipped; audited + grilled 2026-05-31). **DONE:** `emitEvent` bus (`packages/api/src/modules/workflows/events.ts`); triage fully unified (`enqueueTriageRuns` deleted, Gmail worker emits per fresh doc at `queue.ts:297`); closed `EVENT_SOURCES` — now **three** sources `gmail`/`google.oauth.callback`/`learn-skill` (ADR-0047 amendment 2026-05-31; gmail+oauth live, learn-skill emit in flight); `gmail.read_message` liveTool (`riskTier: low`); async `<trigger_event>` with 4k excerpt + unavailable fallback; `WorkflowInput` widened with `userId`+`trigger`; tolerant-read `agentRunTriggerSchema`; dispatch-time allowed-integration cap; **partial index `agent_runs_active_event_idx`** bounding the per-event duplicate check (migration `0026`, grilled 2026-05-31). **Gated gates reads too** — no read carve-out (alt (a)); UX-copy obligation flagged in deferred follow-ups. **8c policy editor — DONE + verified live 2026-05-31:** `row_version` on `user_action_policies` (migration `0027`); `resolveIntegrationMode` shared helper in `@alfred/contracts`; `ACTION_POLICY` synced as a singleton keyed by `userId` (`@alfred/sync` keys/schema/`policySetIntegrationMode` client mutator); server mutator does a **seed-aware read-merge-write** (preserves `system: autonomy`, bumps `row_version`) + pull fetcher; `push.ts` fires `publishPolicyBust` after commit (dual-invalidate); web `useActionPolicy` hook + `ProviderPolicy` `VsSegmented` autonomy/gated control on `/integrations/$provider` carrying the **gated-reads copy**. Verified end-to-end in-browser: flipped gmail gated→autonomy→gated, DB `integration_rules.gmail.mode` tracked each flip with `row_version` 1→2→3 and `system: autonomy` never stripped. **8d risk-tier resolve-endpoint + UI — DONE 2026-05-31:** `riskTierCountsForIntegration` registry helper → `GET /api/integrations/tool-tiers` (server-only registry, web can't import it) → `useToolTiers`/`useIntegrationTierCounts` hook → Capabilities section summary "3 tools · 1 high, 1 low, 1 no-risk" on `/integrations/$provider`; staging-card `RiskPill` badges + email `[<tier>]` subject prefix already shipped. Verified live in-browser. **Event-trigger authoring UI — DONE + verified live 2026-05-31:** workflows are now a **Replicache-synced entity** (decided: server-authoritative editing over a CRUD route since workflow writes carry real invariants — slug uniqueness, `next_run_at` recompute, allowed-integration cap). `row_version` on `workflows` (migration `0028`); `WORKFLOW` keyed by slug in `@alfred/sync` (keys/`syncedWorkflowSchema`/`workflowUpdate` client mutator with an **authorable** trigger schema — `on_signal` omitted, event `filter` not modelled = empty-filter-only contract); server `workflowUpdate` mutator (refuses built-ins via `MutatorForbiddenError`, enforces event source ∈ allowed-integrations, recomputes `next_run_at`, bumps `row_version`) + `WORKFLOW` pull fetcher; seeder bumps `row_version` on definition drift so built-ins re-sync. Web: `useWorkflows`/`useWorkflow` hooks replace the static `BUILTIN_WORKFLOWS` mock on both the list (`syncedWorkflowToView` adapter) and detail pages; the `/workflows/$workflow` **PlanTab is a real editor** — name, prompt, Schedule(cron)/Event(source+type pickers from `EVENT_SOURCES`/`EVENT_TYPES_BY_SOURCE`)/Manual trigger, allowed-integration chips, event-cap validation, dirty-gated Submit; built-ins render read-only (lock banner, disabled inputs, no Submit, Pause disabled). Verified end-to-end in-browser: edited `qa-gated-staging` manual→event→manual, DB `trigger` + `row_version` tracked each save and `next_run_at` stayed null for the event trigger. **`on_signal` deferred** (no signal producer yet). Design locked 2026-05-29; ADR-0047 amended 2026-05-31.
- [x] **Phase 9** — `smoke-boss.ts` **GREEN end-to-end 2026-06-01** (run `run_ogoikbhj2cln`). Script at `apps/server/src/scripts/smokes/smoke-boss.ts`: creates a manual user-authored `@gmail` workflow whose brief **forces delegation** (boss must NOT read directly; spawns a sub-agent and hands it a real ingested `documentId` since `gmail.read_message` reads the `documents` table, not the live API) → search → spawn → poll `read_scratch` → `promote` to `shared.*` → gated draft-send. Installs a smoke action policy (**gmail autonomy + per-tool `gmail.send_draft` gated**, snapshotted + restored in `finally` so the user's real policy is never left changed); polls + auto-approves the gated send across the parent+child run tree. **PASS asserts all of:** `gmail.search` executed via autonomy; `system.spawn_sub_agent` executed + child run completed (loaded gmail, `gmail.read_message` executed); `scratch.inbox.summary` + `shared.summary` both land in `agent_run_context`; `gmail.send_draft` gated → approved → **executed (real send)**; `status=completed`; no `compactor_failed`.

  **Two real milestone gaps surfaced + fixed to get here (not just smoke-tuning):**
  1. **`gmail.send_draft.execute` was a throwing Phase-4 stub.** Implemented the real send — `sendMessage` in `@alfred/integrations/google/gmail.ts` (RFC822 MIME → base64url `raw` → `POST users.messages.send`, RFC-2047 subject encoding, optional `threadId`); wired `gmail.send_draft.execute`. Verified live (delivered real mail; `gmail.send` scope granted). Without this the boss retry-looped the failing send and never completed.
  2. **The terminal scratchpad→Postgres snapshot (ADR-0036) was defined but never wired** — `snapshotScratchToPostgres` had no runtime call site (only its own smoke). Wired it into `agent/worker.ts` on the `completed` outcome (keyed by `runId`; captures the parent's `shared.*` promotes + sub-agent `scratch.*` writes; no-op for child runs; idempotent + best-effort). Validated against live Redis before the green run.

  **Note on wall-clock:** boss runs on `gemini-2.5-pro` (~5 min/turn idle, ~20 min/turn when the shared concurrency-4 worker is also draining live `email-triage`), so a full green run is ~35–40 min here — see [[project_boss_model_latency]]. Behavior, not a defect.

**Verified live across runs (the parts that DO work):** autonomy `gmail.search` + `gmail.read_message` execute immediately (per-tool override split); `system.spawn_sub_agent` executes and creates a child run; `gmail.send_draft` gates → approval → `signalRun` resume → real send. Not a smoke or Phase-8 defect.
