# ADR-0034 — Human-in-the-loop approval taxonomy + action staging

**Decision.** A per-user **action policy** (`user_action_policies`) drives a per-tool-call gate check inside the dispatcher. The dispatcher classifies every tool call against the policy _before_ invoking `execute`. Gated calls write an **action staging row** (`action_stagings`) and park the run with the existing HIL wake primitive, using the staging id as the wake approval id (`wakeCondition.kind='hil'`, `approvalId=stagingId`) plus an action-staging discriminator. The user decides in-app (approve / approve-with-edits / reject-with-reason); a debounced BullMQ delayed job emits an email notification only if the user hasn't decided within the threshold. On resume, the dispatcher invokes `execute` with the (possibly edited) input — or, on reject, synthesizes a structured rejection tool-result with retry-suppression enforced inside the dispatcher.

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
export const POLICY_MODES = ["autonomy", "gated"] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];

export const INTEGRATION_SLUGS = ["system", "gmail", "calendar", "drive" /* ... */] as const;
export type IntegrationSlug = (typeof INTEGRATION_SLUGS)[number];

// Per-integration action lists feed a derived ToolName template-literal type:
export const SYSTEM_ACTIONS = [
  "load_integration",
  "spawn_sub_agent",
  "read_scratch",
  "write_scratch",
  "promote",
] as const;
export const GMAIL_ACTIONS = ["send_draft", "read_message", "search" /* ... */] as const;
export const CALENDAR_ACTIONS = ["create_event", "list_events" /* ... */] as const;
export const INTEGRATION_ACTIONS = {
  system: SYSTEM_ACTIONS,
  gmail: GMAIL_ACTIONS,
  calendar: CALENDAR_ACTIONS,
  /* ... */
} as const;

export type ToolName = {
  [K in IntegrationSlug]: `${K}.${(typeof INTEGRATION_ACTIONS)[K][number]}`;
}[IntegrationSlug];

export const TOOL_RISK_TIERS = ["no_risk", "low", "medium", "high"] as const;
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

On resume (via `wakeRunInTx(tx, { runId, match: { kind: 'hil', approvalId: stagingId } })`, which for a staging runs only inside `stagedAction({ userId, stagingId }).decide(...)` and `.expire()` in `packages/assistant/src/execution/staged-action.ts`; `signalRun` before #1331):

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

`workflows.hil_gates` (ADR-0017) gates entire _steps_ in explicit-DAG workflows; this ADR gates per-_tool-call_ across both brief-only and DAG workflows. They coexist:

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

The `/approvals` UI splits into two surfaces with deliberately different data paths. **(1) The live pending queue** is Replicache-synced (`status='pending' AND requires_approval`) and bounded (rows auto-expire at 24h), so pagination and filtering (integration + risk facets) run **client-side** over the synced collection — filter state in URL search params, "pagination" is windowing not server paging. No server query endpoint backs this surface; adding one would duplicate the Replicache model for a real-time queue. **(2) History** (resolved actions — approved/rejected/expired) is _not_ synced and grows unbounded, so it is a separate **server-paginated + filterable** read model (`GET /approvals?status=&integration=&risk=&page=`), **deferred** until the History tab lands. The card also gains derived provenance on the synced row (`workflowName`, narrowed `trigger`, truncated `brief`); the per-`ToolName` card registry stays a web-only `Partial` map with a generic fallback, and the four decision actions remain uniform across tools. Full implementation slice in [`docs/plans/m13-plan.md §5f`](../plans/m13-plan.md).

**Amendment (2026-10-31) — replay safety: claim before execute, re-approval on reclaim.**

A worker can die after a tool starts its effect and before dispatch commits the result. The executor then reclaims the run, and the same call dispatches again. Before this amendment, only `mcp.call` was protected (its broker ledger). A curated write tool ran a second time, so a second email, invite, or deploy was possible.

1. **Every tool states `replay: "safe" | "unsafe"`.** `"safe"` means a second run makes no second effect (a read, a set, or a provider-side key). `"unsafe"` means a second run can repeat the effect. The field has no default. `riskTier` and `staging` are not the replay signal, because neither tracks whether a repeat is harmless. Only a `staged` or `confirm` tool can be `"unsafe"`, because the other arms write no row to claim; `registerTool` enforces this.
2. **Claim before execute.** For an `"unsafe"` tool, dispatch sets `action_stagings.dispatch_claimed_at` just before `execute`. One transaction locks the `agent_runs` row first, checks the lease (attempt, cancellation generation, not terminal), and then claims an unclaimed `pending` or `approved` row. A claim that fails does not run the tool. If another attempt owns the run, dispatch throws without a row write, and the step commit's ownership guard skips the superseded attempt. If a cancel moved the fence or cancelled the run, dispatch closes the row as a cancelled call. If the run ended in another terminal status (`failed`, `completed`, `blocked`), dispatch throws without a row write, so a failed run does not get the cancelled label. If the row is no longer claimable under a live lease, dispatch throws and the run fails closed. Safe tools skip the claim. The claim time is also the commit token: the result commit matches `dispatch_claimed_at` as well as status and outcome. A zombie attempt (it claimed at t1, then lost its lease, but its `execute` still finishes) can commit only while the row still holds its t1 claim. After a restage and "Run again" clear the claim or a new attempt claims again, the zombie's commit fails and the row keeps the result of the run that the user approved. A cancel that closes a claimed row tells the model that the call may have already run, not that it did not run.
3. **Re-approval on reclaim.** When dispatch finds a claimed `"unsafe"` row with no result, it does not run the call. Under the same lease check as the claim, the row goes back to `pending` with `requires_approval = true`, a new expiry, and a new notice, and the run parks on the normal `hil` wake. If a lost attempt commits its result first, dispatch settles from that result instead. The new notice is a second email. `approvalCardKey` names the card from its claim (`claim-<ms>`), and the notify job id, the job data, and the email idempotency key (`approval:<id>:claim-<ms>`) all carry that key, so the new card's job never meets the first card's job. The worker skips a job whose key does not match the row. The claim time is an identity there, compared only for equality, and dispatch writes it from the app clock, the same value its commit fences on. A user edit stays in `decided_input`, so "Run again" still reports the edit to the model. This applies also under full autonomy and to autonomous rows: a duplicate effect is worse than a wait. The synced row carries `mayHaveRun`, and the card says "This may have already run." Approve ("Run again") clears the claim and runs the call. Reject ("Don't run again") is one click with a fixed note. The card offers no revision, because the result tells the model not to send a corrected call. The reject keeps `outcome = 'refused'`; the claim stays as the record of the earlier possible delivery.
4. **Schema changes do not skip recovery.** Dispatch reads saved staging before it binds the input to the current tool schema. A claimed call gets its card and notification even if a deploy made its saved input invalid. The card keeps the saved risk tier and redacted display when the old input does not bind. Approval with edits must pass the current schema before execution. A settled row replays its stored result without a schema bind.
5. **Reject and expiry suppress the repeat.** A claimed row that is rejected or expires returns `mayHaveRun: true` and a server-written instruction to check the target state and to avoid an identical, corrected, or reworded retry. This signal does not depend on the user's reason. An expired row with a claim suppresses an identical new call in the same run, also under full autonomy. Restaging keeps the original `proposed_input_hash`; rejection lookup also matches the edited input. `system.update_artifact` is unsafe because a text replacement can leave its own search text in the result and can insert text again on a repeat.
6. **No `unknown` outcome for this case.** `findUnresolvedUnknown` has no expiry, so an `unknown` row would block identical calls forever. The re-approval card closes the question with a human decision instead.

7. **The `pending_actions` outbox is removed.** ADR-0014 planned effects as rows in `pending_actions`, written in the step commit through `ctx.stageAction` and run by a separate worker. No step called `ctx.stageAction`, and no worker read the table. `action_stagings` with the claim above is the shipped mechanism. Migration `0159_flashy_mockingbird` drops the table, and `StepContext` no longer has `stageAction`. Do not add an effect path to the step commit; a step reaches an outbound effect only through dispatch.
8. **Deploy drain.** Railway sends SIGTERM and then SIGKILL after `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`. The Railway default is 0 seconds, which gives the graceful path (`stopRuntime` → `Worker.close()`, which waits for active jobs) no time. One integration request can take up to 30 seconds (`INTEGRATION_FETCH_TIMEOUT_MS`), and a tool can make more than one. So the production `server` service sets `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=120` (set 2026-10-31). A step that ends inside the window commits normally. An `"unsafe"` call that is still in flight at SIGKILL becomes a re-approval card. The window does not replace the claim, because a crash or OOM gets no drain.

Provider keys (a Calendar client event id, a kept Gmail draft) can later move a tool to `"safe"`. Each is a separate change. (The first Gmail plan, a fixed `Message-ID` with a Sent check, does not work: see item 10.)

9. **`calendar.create_event` is `"safe"` (2026-10-31).** The tool sends its own event `id`: the SHA-256 hex of the canonical `{ runId, toolCallId, input }`, which is valid base32hex. Google keeps one event per id on a calendar, so a second insert of the same call fails with 409 and sends no second invitation. The tool then reads the event at that id and returns it as the result. If that event is cancelled, the tool returns `calendar_event_cancelled` and makes no new event. The input is in the hash, so an approval with edits makes a new event. A reclaim of this tool now runs it again without a card.

10. **`gmail.send_draft` is `"safe"` (2026-10-31).** A live probe showed that Gmail replaces a caller's `Message-ID` on `messages.send` and on `drafts.create`, so a fixed `Message-ID` with a Sent search cannot find an earlier send. A draft is the key instead: `drafts.send` deletes the draft, so a second `drafts.send` with the same draft id gets 404 and sends nothing. The tool saves the mail as a draft, keeps `{ credentialId, draftId, threadId, alfredSavedAt }` in `action_stagings.provider_ref`, and then sends the draft. The write sets the column only when it is null, so two attempts keep one draft, and the other attempt deletes its own. A rerun sends the kept draft from the kept credential, also when the user has more than one Google account. On 404 the tool reads the draft's thread and returns the SENT message nearest to `alfredSavedAt` (Alfred's clock, with a 60-second margin for Gmail's clock). If the thread is gone or has no such message, the tool returns `gmail_draft_gone`, sends nothing, and says that the mail may not have been sent. `drafts.send` needs `gmail.modify` (Gmail also takes `gmail.compose`, which Alfred does not request), so the tool checks the `gmail_send` grant for consent and calls the draft endpoints with the `gmail_modify` grant on the same credential. The tool is available only with `gmail_modify`. Known residuals: a crash between the draft save and the column write leaves one unsent draft in Drafts; a send that Gmail refuses leaves its draft; the 60-second clock margin can match a different sent reply in the same thread if the draft was deleted; if a zombie attempt is still inside `drafts.send` when a rerun gets 404, the rerun can report `gmail_draft_gone` for a mail that was sent (the error says "may not have been sent"); a timeout or 5xx on `drafts.send` is still a plain failure with no thread check, as before; `provider_ref` now holds this JSON, and the run-history receipt shows it as the provider ref; the reply-drafting access check (`checkGmailSendAccess`) still checks only `gmail_send`.
