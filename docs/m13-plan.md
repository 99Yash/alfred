# m13 — Boss + sub-agent orchestration (implementation plan)

m13 fills the user-authored workflow execution gap left after the planned m12 `user_authored_brief_execution_pending_m13` stub was scoped out, then ships the full boss-agent runtime. It lands three new ADRs in one milestone: **0034** (HIL approval + action staging), **0035** (transcript compaction at 60%), **0036** (Redis-primary scratchpad with Postgres terminal snapshot), on top of **0016** (sub-agent fan-out) and **0026** (`AlfredAgent` per-turn driver).

This is a phased plan. Each phase is "land before the next phase starts"; sub-steps inside a phase are parallel-safe.

Cross-references: [`../CONTEXT.md`](../CONTEXT.md) (glossary — `User action policy`, `Action staging`, `Tool name`, `Run scratchpad`, `Transcript compaction`, etc.), [`../decisions.md`](../decisions.md) (ADRs 0014, 0016, 0017, 0026, 0027, 0034, 0035, 0036).

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

Goal: replace the current registry-miss behavior for user-authored workflows with a real `AlfredAgent` loop driving the dispatcher. **Detailed design locked in [ADR-0040](../decisions.md); this section captures the implementation slice.**

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

`apps/server/src/scripts/smoke-brief-execution.ts` — auto-approves any pending `action_stagings` via direct DB update + `signalRun()`, exercising both autonomous and gated-resume paths. Lives in `apps/server/src/scripts/` alongside the other smokes (`smoke-cold-start`, `smoke-sub-agents`, etc.) rather than under `packages/api/` because it depends on the running server worker. Brief: `"@gmail — Read my most recent inbox email and summarize it in one sentence. Then tell me what's on my calendar tomorrow morning."` Asserts: status=completed, ≥ 2 ping-pong step rows each, `system.load_integration` + `gmail.*` + `calendar.*` executed stagings, `state.activeIntegrations` grew, `api_call_log` count = `boss-turn` count, output text non-empty.

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

Files: scheduling in `packages/api/src/modules/approvals/expiry-queue.ts` (agent-free, imported by the dispatcher), worker in `expiry-worker.ts` (imports `../agent`, started at boot). No migration — `expires_at` already shipped in migration 0017.

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

After every `dispatch-tools` step, the executor calls `tokenCount(agent_runs.transcript)` (AI SDK tokenizer; `@anthropic-ai/tokenizer` for Anthropic models — within ~5% is fine). If the count exceeds `compactionThresholdTokens(model.contextWindow)`, schedule a `compact-transcript` step before the next `boss-turn`.

`model.contextWindow` reads from the new `model_prices.context_window` column.

### 7b. In-flight tail identification

Use `state.inFlightTailStart`, captured by the last `boss-turn`, as the boundary. Preserve `agent_runs.transcript.slice(state.inFlightTailStart)` verbatim. Everything before is fed to the compactor; everything after stays as-is.

### 7c. Compactor invocation

```ts
const result = await meteredGenerateText({
  model: getCheapModel(),
  attribution: { kind: 'llm', role: 'compactor' },
  maxOutputTokens: 2000,
  system: COMPACTOR_SYSTEM_PROMPT,
  messages: priorTranscriptToCompact,
});
nextTranscript = [
  { role: 'system', content: `<run_summary>${result.text}</run_summary>` },
  ...inFlightTail,
];
```

`COMPACTOR_SYSTEM_PROMPT` enforces: 2000-token cap, drop verbatim text, keep IDs + decisions + every approved/rejected/failed action with outcome + every sub-agent finding, **preserve mid-run user intent statements verbatim under `<user_directives>` — do not paraphrase**. Each `<action>` is one short line.

XML schema sections (per ADR-0035): `goal`, `user_directives`, `decisions`, `actions_completed`, `actions_rejected`, `actions_failed`, `sub_agent_findings`, `pending_followups`, `key_entities`.

### 7d. Cache breakpoint

Place a third ephemeral `cacheControl` breakpoint immediately after the `<run_summary>` system note (ADR-0026 reserved this slot for compaction). The system message + last tool definition breakpoints from ADR-0026 are unchanged.

### 7e. Fault behavior

Compactor call failure → run fails with `reason='compactor_failed'`, retryable. No degraded fallback (running with overflowing context = hallucination / silent truncation). Retry on next executor wake.

### 7f. Prompt engineering pass

Budget real time. ADR-0035 marks the prompt as "sketched, not engineered" — run long workflows in staging, inspect handoff outputs, tighten the prompt until directives and decisions consistently survive a compaction round-trip.

### Phase 7 acceptance

- A run with a manually inflated transcript hits the threshold, runs `compact-transcript`, and continues with the new `agent_runs.transcript` shape `[<run_summary>, in-flight tail]`. The stable boss system prompt and tool definitions remain outside the transcript as `AlfredAgent.turn()` inputs.
- `<user_directives>` content is preserved verbatim (not paraphrased) across a compaction.
- One `api_call_log` row per compaction with `attribution.role='compactor'`.
- Compactor failure surfaces as a real run failure (not silent quality loss).

---

## Phase 8 — Other dispatchers + policy UX

Goal: light up the `event` trigger kind and ship the policy editing surface. **Scope locked in grilling 2026-05-29 → ADR-0047; `on_signal` (8b) deferred** (no signal producer exists in the codebase, so a dispatcher would be untestable dead code).

### 8a. `event` trigger dispatcher — the `emitEvent` bus (ADR-0047)

Generic bus, **one dispatch path**, triage unified onto it. Detailed design in [ADR-0047](../decisions.md).

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

## Status board (update inline as work lands)

- [x] **Phase 1** — Foundations: contracts package, migrations, signup hook
- [x] **Phase 2** — Runtime primitives: scratchpad helpers, tool registry, initial tool slice
- [x] **Phase 3** — Dispatcher (the spine) — open ADR items resolved
- [x] **Phase 4** — Agent bridge: ping-pong `boss-turn` ↔ `dispatch-tools` steps + sentinel `userAuthoredBriefWorkflow` + `agent_runs.transcript` jsonb + `system.load_integration` + strict `@`-mention seed (ADR-0040). Smoke at `apps/server/src/scripts/smoke-brief-execution.ts`.
- [~] **Phase 5** — HIL surface. Code-complete: server `ACTION_STAGING` pull fetcher (5a-server), `useActionStagings` Replicache hook + live `/approvals` page wired to the decision API (5a-web/5b), `POST /api/approvals/:stagingId/decision` (5c), `staging-notify` debounce worker scheduled from the dispatcher + started at boot (5d), and the `staging-expire` worker (5e — **kept**; dispatcher sets `expires_at` + schedules the job, worker flips `pending`→`expired` and signals the run, decision API cancels the job). Remaining: live click-through verification against a real gated run (manual QA — needs the full stack + a real gated tool call).
- [x] **Phase 6** — Sub-agents: spawn (`spawnSubAgent`), zone enforcement at the dispatcher, scratchpad tools (`system.read_scratch` / `system.write_scratch` / `system.promote`), and fail-back via `scratch.{subId}.error` (the latter closes alongside Phase 7's threshold infra).
- [x] **Phase 7** — Compaction: `lastInputTokens` token accounting, in-flight tail via `state.inFlightTailStart`, `compactTranscript` primitive at `packages/api/src/modules/agent/compaction/`, ephemeral `cacheControl` on the `<run_summary>` system message, `CallRole` plumbing with `'compactor'` wired, boot-time `verifyMeteringModels`, ADR-0046 stub for the future per-run cost ceiling. Fixture smoke at `apps/server/src/scripts/smoke-compaction.ts`; 7f prompt pass still owed.
- [ ] **Phase 8** — `event` dispatcher (`emitEvent` bus, triage unified — ADR-0047) + policy editor UI (Replicache-synced) + risk-tier UX. **`on_signal` deferred** (no signal producer yet). Design locked 2026-05-29.
- [ ] **Phase 9** — `smoke-boss.ts` green
