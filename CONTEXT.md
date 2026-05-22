# Alfred — Shared Vocabulary

Living glossary of the load-bearing terms. One to three lines per term. Refine in place when usage drifts; don't re-litigate in chat.

Cross-references: [`decisions.md`](./decisions.md) (the ADRs, snapshot table at the top), [`CLAUDE.md`](./CLAUDE.md) (operational guide).

---

## Core domain

**Skill.** A markdown body + frontmatter the agent mounts into its system prompt. Activated by `@skill:slug` in a brief or chat. Authoritative storage: `skills` + `skill_revisions`. ADR-0017.

**Workflow (row).** A row in the `workflows` table. Holds trigger spec, brief, optional steps DAG, status, allowed-integrations, HIL gates. Source of truth for the *settings UI* and the *trigger dispatcher* — not for execution shape.

**Workflow (code).** A `Workflow<S>` object passed to `registerWorkflow()` at server boot. Source of truth for *execution* (steps, initialState, dedupKey). Built-ins live as both a row AND a code object; user-authored live as a row only — and need a generic code-side workflow that interprets the brief at runtime.

**Run.** One execution of a workflow. Stored as one row in `agent_runs`. Joins back to the workflow via `agent_runs.workflow_slug`. There is no separate `workflow_runs` table — `agent_runs` covers status, timing, cost attribution.

**Brief.** Two scopes, both legitimate:
1. *Workflow brief* (ADR-0017): the user's natural-language description of what the workflow should do. Stored on `workflows.brief`.
2. *Sub-agent brief* (ADR-0026): the initial transcript handed to a spawned sub-agent. Stored as the first message of a child `agent_runs.transcript`.
   When ambiguous, qualify: "workflow brief" or "sub-agent brief."

**Trigger.** Discriminated union on `workflows.trigger.kind`: `cron` | `event` | `manual` | `on_signal`. The dispatcher consults `status='active'` before enqueuing a run.

**HIL gate.** A step id listed in `workflows.hil_gates`. The runtime parks the run on `wakeCondition.kind='hil'` when entering the step; user approval flips it back to `runnable`. Only meaningful with explicit `steps`. For brief-only workflows (m13+), HIL is driven by the **user action policy** instead — see below.

**User action policy.** Per-user row in `user_action_policies` storing `default_mode` (`autonomy` | `gated`), `integration_rules` jsonb keyed by integration slug, and `approval_notify_delay_ms`. The tool dispatcher consults it on every tool call; `gated` results land as staged actions awaiting human decision. Default at signup: `gated`, with `system.*` tools seeded to autonomy. ADR-0034.

**Policy mode.** `autonomy` (execute immediately) or `gated` (stage for HIL approval). Resolution at dispatch: per-tool override → per-integration mode → user default. Both modes are const-narrowed string unions from `@alfred/contracts`, never open strings.

**`@alfred/contracts`.** New tiny package (sibling to `@alfred/sync`, `@alfred/env`) holding cross-boundary types + const tables: `INTEGRATION_SLUGS`, `POLICY_MODES`, per-integration `*_ACTIONS` lists, derived `ToolName`, future attribution/signal kinds. Zero Node deps; importable from `packages/db`, `packages/api`, `apps/web` without runtime-bundle leaks. Pure named exports + `as const`; no side effects at import time.

**Tool name.** Canonical form `${IntegrationSlug}.${ActionSlug}` — both halves are const-narrowed unions from `@alfred/contracts`. Per-integration action lists (`SYSTEM_ACTIONS`, `GMAIL_ACTIONS`, `CALENDAR_ACTIONS`, …) compose via `INTEGRATION_ACTIONS` into a single `ToolName` template-literal type. `system.*` is for internal tools like `system.load_integration` and scratchpad operations. Schema columns and dispatcher signatures use `ToolName` exclusively; no open strings, no `string & { __brand }` shortcuts.

**Action staging.** Row in `action_stagings` — one per proposed tool call, gated or autonomy. Gated rows park the run on `wakeCondition.kind='hil'` with `approvalId=stagingId` until user decides (approve / edit / reject); autonomy rows transit `pending → executed` in ms. Idempotent on `(run_id, tool_call_id)` for crash-resume. Carries `row_version` for Replicache, `risk_tier` for UI/email snapshots, and `proposed_input_hash` for retry suppression. Canonical audit record for "what did Alfred try and what happened?" ADR-0034.

**Approval debounce.** When a gated staging row lands, SSE pokes the web UI immediately; a BullMQ delayed job is also scheduled using `user_action_policies.approval_notify_delay_ms` (default 5min). If the user decides in-app before the delay fires, the job is removed and no email goes out. If the job fires with the row still `pending`, it calls `notify({ userId, kind: 'approval', idempotencyKey: 'approval:' + stagingId, ... })`, sending one email per staging row. Tracked by `action_stagings.notify_after_at` (scheduled fire time) and `notified_at` (actual fire time). ADR-0034.

**Rejection contract.** When the user rejects a staged action, the boss's resumed turn receives a structured tool-result: `{ status: 'rejected_by_user', toolName, proposedInput, reason, retryPolicy: 'do_not_retry_identical' }`. The dispatcher *enforces* the retry policy: a second stage attempt with the same `(run_id, tool_name, hash(proposed_input))` synthesizes another rejection without re-staging or re-emailing. Reject UI exposes two affordances: "Reject and continue" (default) and "Reject and end run" (triggers `cancelRun(runId)` with `reason='cancelled_by_user'`). Reason text is required. Staging cards render a banner with the most recent rejection for the same `(user_id, tool_name)` if one exists in the last N days — so the user (and the boss, on resume) sees why a similar action was rejected before. ADR-0034.

**Tool risk tier.** Const-narrowed enum at tool registration time, declared in `@alfred/contracts`: `no_risk | low | medium | high`. Pure UX hint at v1 — the dispatcher reads only `user_action_policies`, never `riskTier`. Drives integration-card summaries ("Gmail — 12 tools (4 high, 5 medium, 3 low)"), staging-card badges, and email subject prefixes. Staged rows snapshot the risk tier so old approvals don't change copy after a registry edit. Authors classify on registration; trust-the-author at v1, custom lint rule when the registry grows past ~30 tools. ADR-0034.

## Compaction

**Transcript compaction.** Distinct executor step inserted between `dispatch-tools` and the next `boss-turn` when token-count crosses `compactionThresholdTokens(model.contextWindow)` (60% of context window). Compactor is `getCheapModel()`; output capped at 2000 tokens. Preserves system message, tool definitions, and the in-flight tail (last assistant message + its tool calls + results) verbatim; everything older compresses into the run handoff. Sub-agents do not compact (fail back to the boss for re-decomposition per ADR-0026). ADR-0035.

**Run handoff.** Structured XML `<run_summary>` emitted by the compactor, replacing older transcript content. Sections: `goal`, `user_directives`, `decisions`, `actions_completed`, `actions_rejected`, `actions_failed`, `sub_agent_findings`, `pending_followups`, `key_entities`. A third ephemeral `cacheControl` breakpoint goes after the `<run_summary>` so subsequent turns hit a stable cached prefix until the next compaction. ADR-0035.

**User directives vs decisions.** Two distinct handoff sections by design. `<user_directives>` = pragmatic, mid-run intent statements that bound the agent's future behavior ("trust gmail for the rest of this conversation"), preserved verbatim. `<decisions>` = epistemic, facts/preferences/constraints learned during the run ("Alice is the manager"). The compactor's system prompt enforces "do not paraphrase under `<user_directives>`" — paraphrasing introduces drift on intent grants. ADR-0035.

## Scratchpad

**Run scratchpad.** Per-run K/V store for sub-agent findings + boss-promoted shared state. **Redis** is the live store during the run (keys `alfred:scratch:{runId}:{zone}.{path}`, 30-day TTL). **Postgres** receives a per-key snapshot via `agent_run_context` at the executor's terminal step (success / failure / cancel), idempotent via `ON CONFLICT (run_id, key) DO UPDATE`. Crash-resume of a lost scratch entry mid-run = re-execution of the producing step (ADR-0014's idempotency). Per-zone single-writer enforced at the dispatcher: only `sub_a` writes `scratch.sub_a.*`; only the boss writes `shared.*`. ADR-0036 (amends ADR-0016).

**`shared.*` vs `scratch.{subId}.*`.** Two namespaces inside the run scratchpad. `scratch.{subId}.*` is sub-agent advisory state (unvalidated; the sub-agent owns it). `shared.*` is boss-promoted canonical state (validated; only the boss writes). Sub-agents read both but write only their own zone. Cross-pollination across sub-agents flows through `shared.*` — the boss is the gate. ADR-0016 + ADR-0036.

**Active integrations.** `agent_runs.state.activeIntegrations: string[]` — the toolset the agent can currently call. Seeded from `@`-mentions in the brief, grown by `load_integration(slug)` tool calls, capped by `workflows.allowed_integrations`. ADR-0026.

**Builtin vs user-authored.** `workflows.is_builtin = true` for alfred-curated workflows seeded from the repo (immutable except `status`); `false` for user-authored (full CRUD). Same table, same toggle UX.

## Runtime primitives

**Tick.** A BullMQ repeatable that fans out per-user. Existing pattern: `briefing.tick` (hourly, `packages/api/src/modules/briefing/repeatable.ts`). m12 adds `workflows.tick` (every minute, generic) per ADR-0027.

**Dispatcher.** The piece that turns a trigger into a `createRun` + `enqueueRun` call. Exists implicitly per-feature today (e.g. the briefing tick handler); m12's `workflows.tick` is the first generic dispatcher.

**`next_run_at`.** Denormalized timestamp on the `workflows` row. Recomputed (via `cron-parser`) at exactly two moments: when `trigger`/`status` mutates, and inside the tick after a successful `createRun`. The tick query is an index lookup, not a scan. ADR-0027.

**`trigger` (on `agent_runs`).** First-class jsonb column on the run, mirroring `workflows.trigger.kind` plus per-kind metadata (`scheduledFor`, `eventId`, `payload`, `signalName`). Source of truth for "why did this run fire?" Replaces ad-hoc `metadata.triggeredBy` stuffing. ADR-0027.

**Scheduled-instant jobId.** BullMQ `jobId = workflow:{workflowId}:scheduled:{nextRunAtIso}`. Idempotency primitive: a retried tick is a no-op via BullMQ's native dedup without consulting Postgres. ADR-0027.

**Per-turn LLM driver.** `AlfredAgent` (ADR-0026, `packages/ai/src/agent.ts`). One `turn()` call = one LLM round-trip = one `api_call_log` row. Composes with the durable runtime; not yet wired into any agent_run.

## Authoring shapes

**Brief-only workflow.** `steps = null`, `brief != null`. Intended runtime: a single `AlfredAgent`-driven loop that uses the brief as system prompt and tools from `allowedIntegrations`. **m12 stores these but does not execute them** — Activate flips status to `active`, the cron tick still fires, but the resulting run lands as `failed` with reason `user_authored_brief_execution_pending_m13`. m13 fills in tool dispatch + `load_integration` + `AlfredAgent`→runtime bridge.

**Explicit-DAG workflow.** `steps != null`. Runtime executes deterministically; node kinds: `run_skill | tool_call | llm_call | agent_run | condition | parallel | loop | hil_approve`. The Zod schema exists; runtime support for these node kinds is partial (only `agent_run` is implicit via the executor; the rest are unbuilt).

**Hybrid workflow.** Explicit DAG with embedded `agent_run(brief)` nodes — deterministic outer, LLM-decided inner. Forward-compatible; not v1.

## m12 scope (locked 2026-05-11)

**Authoring + dispatch only. Execution deferred to m13.**

- 12a/12b/12c **CRUD + UI + Replicache sync** for skills and user-authored workflows. Brief-only authoring (no DAG editor). Schema column `workflows.steps` stays for forward-compat; API rejects writes to it.
- 12d **Trigger dispatch**: ship `cron` (UI + generic `workflows.tick` dispatcher) and `manual` ("Run now" button). `event` and `on_signal` segments render disabled in UI with a "lands with m13" tooltip; no dispatcher built. (ADR-0027.)
- 12e **Settings page**: unified active↔paused toggle for builtins + user-authored. Closes the m9 deferral.
- **Brief-only execution stub**: when the dispatcher fires a `createRun` for a workflow with `is_builtin=false`, the run lands as `failed` with reason `user_authored_brief_execution_pending_m13`. History tab on the workflow detail page shows those rows honestly.
- m13 then builds the tool dispatcher + tool registry + `load_integration` + `AlfredAgent`→runtime bridge + sub-agents in one pass, replaces the stub, and lights up the History/Approvals tabs.
