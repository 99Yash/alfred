# ADR-0034 — Human-in-the-loop approval taxonomy + action staging


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

The `/approvals` UI splits into two surfaces with deliberately different data paths. **(1) The live pending queue** is Replicache-synced (`status='pending' AND requires_approval`) and bounded (rows auto-expire at 24h), so pagination and filtering (integration + risk facets) run **client-side** over the synced collection — filter state in URL search params, "pagination" is windowing not server paging. No server query endpoint backs this surface; adding one would duplicate the Replicache model for a real-time queue. **(2) History** (resolved actions — approved/rejected/expired) is *not* synced and grows unbounded, so it is a separate **server-paginated + filterable** read model (`GET /approvals?status=&integration=&risk=&page=`), **deferred** until the History tab lands. The card also gains derived provenance on the synced row (`workflowName`, narrowed `trigger`, truncated `brief`); the per-`ToolName` card registry stays a web-only `Partial` map with a generic fallback, and the four decision actions remain uniform across tools. Full implementation slice in [`docs/plans/m13-plan.md §5f`](../plans/m13-plan.md).
