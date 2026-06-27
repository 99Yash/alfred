# Observability: background-workflow decision traces + drift metrics (#219)

**Status:** proposed (2026-06-27). Closes #219. Recommends **ADR-0077**.
**Deps:** #214 (tool spans, done), #215 (I/O capture, done), #226 (trace envelope, done).
**Sibling:** the user-model epic #218 — this is the measurability substrate it tunes against.

## Problem

`#210`/`#211`/`#212` were each found by a **manual prod SQL audit**, not by any signal
the system raised. Self-ingestion (#211) ran ~9 days before a human noticed. Two gaps:

1. **No durable "why this tag" decision trace.** The full structured record *already
   exists* — `senderExtractionEvent()` (`apps/server/src/builtins/workflows/email-triage.ts:811`, type at `:769`)
   assembles deterministic context (persona, sender prior, relationship prose, thread
   state, content flags) + audit (first pass, conflict kind, second pass, override floor)
   + final category/confidence + todo outcome + standing-instruction suppression. But it's
   `JSON.stringify`'d into `ctx.log()`, which publishes an untyped `agent.progress`
   payload (`executor.ts:142`) — durable as an outbox event, but not a first-class
   queryable decision record.
2. **No drift/invariant metrics.** Nothing pushes "self-ingestion regressed" or
   "urgent+action_needed is 26% of inbox." Drift is discovered by audit, not raised.

## Decisions (→ ADR-0077)

- **The two halves are complementary, not layered.** Drift metrics read the *source of
  truth* (`documents` / `email_triage` / `todos`) and **raise the flag**; decision traces
  **explain it** when an operator drills in after a breach. In v1 the drift queries do
  **not** read `agent_decision_traces` — the table is write-only forensic substrate, sized
  for "why did *this* tag fire," not aggregate slicing. (Aggregating over traces is a
  v1.1 seam once volume/justification exists.)
- **Decision traces live in the DB**, not Langfuse. The motivating incidents were all
  found by SQL prod audits; the trace must live where they're queried, with durable
  retention. Langfuse generations already carry the model I/O (#215) for live inspection;
  we do **not** double-write the structured trace to Langfuse in v1.
- **The trace is a step-level side effect**, emitted via a new `ctx.trace(kind, record)`
  parallel to the existing `ctx.stageAction` / `ctx.log`, persisted inside the step's
  commit transaction. Workflows opt in per decision; triage is the first producer, the
  seam is generic so briefing / memory-extraction / cold-start adopt incrementally.
- **Drift metrics are snapshot rows + breach-push.** Every scheduled run writes a
  `drift_metrics` snapshot (the trend substrate); a threshold breach fires a single
  `notify()` email to the operator. Normal runs are silent — "pushed when it matters,"
  not a routine digest that re-creates inbox noise.

## Half 1 — decision traces

### Schema: `agent_decision_traces` (packages/db/src/schema/agent.ts)

Joins the `agent_*` family. One row per traced decision.

| column | type | notes |
|---|---|---|
| `id` | bigserial PK | cheap, like `agent_steps`; nothing FKs to it |
| `runId` | text → `agent_runs.id` CASCADE | dies with the run |
| `userId` | text → `user.id` CASCADE | denormalized for user-scoped drift queries |
| `workflowSlug` | text | denormalized filter-by-workflow |
| `stepId` | text | |
| `attempt` | integer | a retried attempt = distinct rows (forensics) |
| `kind` | text | discriminator, e.g. `triage.classification` |
| `decisionKey` | text | stable per-step discriminator; default `default` for one decision of a kind |
| `trace` | jsonb `$type<DecisionTraceEnvelope>` | the structured record (precise per-kind type at the producer/reader) |
| `decidedAt` | timestamp defaultNow | |
| `...lifecycle_dates` | | |

- **Unique** `(run_id, step_id, attempt, kind, decision_key)` → re-running a trace slot is
  `onConflictDoNothing` (idempotent, mirrors `pending_actions`), while multiple same-kind
  decisions in one step must use distinct keys instead of silently clobbering.
- **Index** `(user_id, kind, decided_at)` and `(workflow_slug, kind, decided_at)` for drift slices.
- No retention machinery v1 (volume ~3k rows/mo; CASCADE cleans up on run/user delete).
  Note as a revisit-if-volume-grows seam.

### Trace-kind registry + the `SenderExtractionEvent` move

Package-boundary reality: `@alfred/db` imports `@alfred/contracts`, and `@alfred/api`
imports `@alfred/contracts` — but **contracts cannot import api**. `SenderExtractionEvent`
(currently a private interface at `email-triage.ts:769`) closes over `Observations` /
`ClassifyAudit` / `SenderContextResult` / `ContentFlags` / `ThreadState` / `TriageConflict`
— **all of which already live in `packages/api/src/modules/triage/`**. So:

- **Move `SenderExtractionEvent` + the `senderExtractionEvent()` assembler *down* into the
  `@alfred/api` triage module** (its dependency types are already there — zero new cross-package
  refs), export both from the triage barrel. `email-triage.ts` imports them from `@alfred/api`.
  *Not* contracts — moving it to contracts would force its whole leaf-type tree up with it.
- **Registry lives in `@alfred/api`** (`modules/agent/decision-traces.ts`): a discriminated
  map `kind → payload type`, with `triage.classification → SenderExtractionEvent`. This is
  the typed surface producers/readers share. Derive, don't hand-roll.
- **DB column stays untyped `jsonb("trace")`** — matching the existing variable-shape
  agent sinks (`pending_actions.payload`, `agent_run_context.value` are plain `jsonb`; only
  the fixed-shape `transcript` uses `$type`). No contracts envelope needed. The typed
  surface is `ctx.trace`, made **generic over the registry**:
  `trace<K extends DecisionTraceKind>(kind: K, record: DecisionTraceFor<K>)` — so
  `ctx.trace("triage.classification", senderExtractionEvent(...))` fails to compile if the
  record shape drifts. The `kind` column is the queryable discriminator.

### The seam (`ctx.trace`)

- `packages/api/src/modules/agent/types.ts` — add to `StepContext`:
  `trace(kind: string, record: unknown, { decisionKey? }): void` (docstring: durable
  structured decision record, persisted with the step commit).
- `executor.ts` — collect into a `traces: TraceRecord[]` array (parallel to `staged`),
  push in the ctx method; in `commitStepSuccess`, insert all traces in the same tx,
  sanitized via the ADR-0070 `sanitizeToolResult` path, `onConflictDoNothing`. Persist on
  success commit only (`next`/`done`/`interrupt`); failure path drops them. Triage also writes
  its classification trace inside the `upsertTriage` row transaction, so a crash after the
  canonical tag write cannot leave the row without its forensic trace.

### Producer: triage (v1)

- `email-triage.ts:554` — replace the `JSON.stringify(senderExtractionEvent(...))`
  progress-log with `ctx.trace("triage.classification", senderExtractionEvent(...))`.
  Keep the terse `classify: doc=… category=…` log for live progress.

## Half 2 — drift metrics

### Schema: `drift_metrics` (packages/db/src/schema/)

Snapshot rows so metrics trend over time (the measurability substrate #218 tunes against).

| column | type | notes |
|---|---|---|
| `id` | bigserial PK | |
| `userId` | text → `user.id` CASCADE | |
| `metric` | text | `self_ingestion_count` \| `attention_share_7d` \| `todo_dismiss_done_ratio` |
| `value` | real | the scalar |
| `windowLabel` | text | e.g. `7d` (null for point counts). **Not `window`** — that's a SQL reserved word; spare the raw `railway ssh` drift queries the quoting. |
| `detail` | jsonb | numerator/denominator, sample ids, threshold, breached:bool |
| `capturedAt` | timestamp defaultNow | |
| `...lifecycle_dates` | | |

- Index `(user_id, metric, captured_at)`.

### Module: `packages/api/src/modules/drift-audit/` — no new worker

All BullMQ workers run **in-process in the single `apps/server` container**, so a dedicated
worker buys ~$0 of Railway compute (2 users, $7–9/mo) while costing ~2 persistent Redis
connections + boot/shutdown surface. Drift reads the same `documents`/`email_triage` data
the memory module already sweeps every 24h, so we **fold it into the memory queue** rather
than standing up a 9th worker:

- `metrics.ts` — one pure query fn per metric + a `runDriftHealthCheck(userId)` that
  evaluates all metrics, writes snapshot rows, and pushes on breach. This is the whole
  module's logic — kept separate from `memory/` so the concern is legible.
- `index.ts` — exports `runDriftHealthCheck` for the memory processor to call.
- **Memory queue, not a new one:** add a `memory.drift_health_check` kind to
  `MemoryJobData` (`memory/queue.ts:20`); `processMemoryJob` dispatches to
  `runDriftHealthCheck`. Add one `upsertJobScheduler("memory.drift_health_check",
  { every: 24h })` to `scheduleRepeatableMemoryJobs()` (`memory/repeatable.ts`). **Zero new
  boot/shutdown lines in `apps/server/src/index.ts`.**

### v1 metrics

1. **`self_ingestion_count`** (acceptance, required) — count `documents` where
   `metadata->>'from'` matches Alfred's own send identity, `source='gmail'`, recent window.
   **Threshold: > 0 → breach** (#211 regression: the ingestor *drops* self-mail, so this is
   normally 0; any row = the drop regressed). The self-identity helper is currently
   duplicated (`integrations/.../ingestor.ts:225` + `backfill-retire-self-mail-committed.ts:71`) —
   **extract one shared `selfSenderEmail()`** and reuse it in all three sites rather than
   inlining a fourth copy.
2. **`attention_share_7d`** (acceptance, required) — `count(category IN
   (urgent, action_needed) in 7d) / count(all classified in 7d)`. Uses the existing
   `email_triage_user_category_idx`. **Threshold: > 0.20 → breach** (#210 cited 26%).
3. **`todo_dismiss_done_ratio`** (cheap add) — `dismissed:done` over 7d
   (`todos.status` + `completed_at`). Issue cites 41:1. Informational; high threshold.
4. **Briefing-loop resurface count** — *deferred to v1.1*: `previouslySurfaced` is a
   computed gather flag, not a column, and tangled with #283 dedup. Log the deferral.

### Breach-push

- **Extend the closed `NotificationKind` union** (`notifications/notify.ts:13`) with
  `health_alert` (and document its key convention in the `notifications` schema doc) —
  `notify()` won't type-check otherwise.
- On any breach, `notify()` a `health_alert` email to the operator, idempotency-keyed
  `health_alert:{userId}:{metric}:{YYYY-MM-DD}` (≤1 alert/metric/day). Normal runs silent.
- Thresholds are module constants (single-user); noted as tunable.
- Folding a health line into the briefing's unused `auditSummary` field is a deferred
  nicety — keeps drift-audit decoupled from briefing compose for v1.

## Phasing

Two natural PRs: **PR-A = Half 1** (phases 1–2), **PR-B = Half 2** (phases 3–4). They share
no code; PR-A is independently shippable. ADR + docs (phase 5) land with whichever merges last.

1. **Schema + seam** — `agent_decision_traces` table + migration (`db:generate` →
   `db:migrate`, never push), `ctx.trace`, trace-kind registry, move `SenderExtractionEvent`
   to contracts.
2. **Triage producer** — convert `senderExtractionEvent` callsite; verify a local triage
   run writes a trace row.
3. **Drift logic + `drift_metrics` table** — `drift-audit` module (metrics 1–3 +
   `runDriftHealthCheck`), extract shared `selfSenderEmail()`, fold `memory.drift_health_check`
   into the memory queue + repeatable. No new worker.
4. **Breach-push + verification** — extend `NotificationKind` with `health_alert`;
   `notify()` on breach; local verify; optional prod replay.
5. **ADR-0077 + docs** — write the ADR, update memory.

## Non-goals / guardrails

- No `db:push`. No Langfuse double-write of the structured trace. No instrumenting all 10
  workflows in v1 (triage only; seam is generic). `pnpm check-types` + `check:web-boundaries`
  clean. `serverEnv()` for env, never `process.env`.
