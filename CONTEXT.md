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

**HIL gate.** A step id listed in `workflows.hil_gates`. The runtime parks the run on `wakeCondition.kind='hil'` when entering the step; user approval flips it back to `runnable`. Only meaningful with explicit `steps`.

**Active integrations.** `agent_runs.state.activeIntegrations: string[]` — the toolset the agent can currently call. Seeded from `@`-mentions in the brief, grown by `load_integration(slug)` tool calls, capped by `workflows.allowed_integrations`. ADR-0026.

**Builtin vs user-authored.** `workflows.is_builtin = true` for alfred-curated workflows seeded from the repo (immutable except `status`); `false` for user-authored (full CRUD). Same table, same toggle UX.

## Runtime primitives

**Tick.** A BullMQ repeatable that fans out per-user. Existing pattern: `briefing.tick` (hourly, `packages/api/src/modules/briefing/repeatable.ts`). m12 adds `workflows.tick` (minute-ly, generic) per ADR-0027.

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
