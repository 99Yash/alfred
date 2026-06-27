import type { AgentTranscriptMessage } from "@alfred/contracts";
import { agentRunTriggerSchema, type AgentRunTrigger } from "@alfred/schemas";
import { sql } from "drizzle-orm";
import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createId, lifecycle_dates } from "../helpers";
import { user } from "./auth";

export { agentRunTriggerSchema };
export type { AgentRunTrigger };

/**
 * Trigger that caused an `agent_runs` row to be inserted (ADR-0027).
 *
 * Mirrors `workflows.trigger`'s shape at the union level but carries the
 * concrete firing context: a cron tick stamps `scheduledFor`, an event
 * dispatch stamps `eventId` (used by callers as a per-event idempotency
 * key), a manual "Run now" carries no payload, an on-signal dispatch
 * names the signal.
 *
 * All four kinds funnel through one `createRun` primitive — no per-kind
 * execution paths. Old call-sites that stamped `metadata.triggeredBy`
 * migrate to populating this column directly; `metadata` is reserved for
 * diagnostic breadcrumbs (e.g. which webhook delivery id fanned out).
 */

/**
 * One row per durable agent run.
 *
 * `state` is the workflow-defined snapshot persisted between steps; the
 * runtime treats it as opaque jsonb. `current_step` names the step the
 * executor will pick up next. `wake_condition` parks an interrupted run
 * (HIL approval, timer, or named signal) until something flips it back
 * to `runnable`.
 *
 * Status semantics:
 *  - `pending`     — enqueued, never picked up
 *  - `runnable`    — ready to execute the next step
 *  - `running`     — a worker holds the lease (heartbeat in `last_checkpoint_at`)
 *  - `waiting`     — parked on `wake_condition`; resume signal flips to runnable
 *  - `completed`   — terminal success
 *  - `failed`      — terminal error
 *  - `cancelled`   — terminal user-initiated stop
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("run")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workflowSlug: text("workflow_slug").notNull(),
    brief: text("brief"),
    status: text("status").notNull().default("pending"),
    state: jsonb("state")
      .notNull()
      .default(sql`'{}'::jsonb`),
    transcript: jsonb("transcript")
      .$type<AgentTranscriptMessage[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    currentStep: text("current_step").notNull(),
    attempt: integer("attempt").notNull().default(0),
    wakeCondition: jsonb("wake_condition"),
    error: jsonb("error"),
    output: jsonb("output"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /**
     * What caused this row to be inserted (ADR-0027). Discriminated by
     * `kind`; see `agentRunTriggerSchema`. Nullable for legacy rows
     * inserted before this column existed — new `createRun` calls always
     * populate it.
     */
    trigger: jsonb("trigger").$type<AgentRunTrigger>(),
    /**
     * Optional workflow-declared singleton key. When non-null and the run
     * is not in a terminal-failure state, no second row with the same
     * (user_id, workflow_slug, dedup_key) can exist — see the partial
     * unique index below. Used by lifetime-once workflows like
     * cold-start-research; left null by everything else.
     */
    dedupKey: text("dedup_key"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    lastCheckpointAt: timestamp("last_checkpoint_at", { withTimezone: true }),
    ...lifecycle_dates,
  },
  (t) => [
    index("agent_runs_user_idx").on(t.userId, t.status),
    index("agent_runs_runnable_idx")
      .on(t.lastCheckpointAt)
      .where(sql`${t.status} IN ('pending', 'runnable', 'running')`),
    // Enforces "at most one active run per (user, workflow, dedup_key)."
    // Excludes failed/cancelled so a transient outage doesn't permanently
    // lock a workflow out — a later trigger can produce a fresh attempt.
    // Workflows opt in by declaring `dedupKey` on their definition; rows
    // with a null dedup key are unaffected (most workflows).
    uniqueIndex("agent_runs_dedup_key_idx")
      .on(t.userId, t.workflowSlug, t.dedupKey)
      .where(sql`${t.dedupKey} IS NOT NULL AND ${t.status} NOT IN ('failed', 'cancelled')`),
    // Bounds the `emitEvent` non-terminal duplicate check (ADR-0047), which
    // runs per inbound event (e.g. every triaged email). The partial WHERE
    // must stay byte-identical to `hasNonTerminalEventRun`'s status predicate
    // so the planner uses it; non-terminal runs are a small, self-draining
    // set, so this stays a tiny lookup regardless of total agent_runs history.
    // The jsonb source/type/eventId/reason predicates filter the matched
    // handful in memory — no jsonb index needed.
    index("agent_runs_active_event_idx")
      .on(t.userId, t.workflowSlug)
      .where(sql`${t.status} NOT IN ('completed', 'failed', 'cancelled')`),
  ],
);

/**
 * Per-attempt step record. `(run_id, step_id, attempt)` is the idempotency
 * key passed to billable downstream calls (LLM/Voyage/Slack/etc.) so
 * retries dedupe at the provider edge per ADR-0014.
 *
 * A step row is inserted *before* the step body runs (status='running')
 * and updated to 'completed' / 'failed' / 'interrupted' at commit. If the
 * worker dies mid-step, recovery sees a stale 'running' row and creates
 * a new attempt rather than rewriting it.
 */
export const agentSteps = pgTable(
  "agent_steps",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    stepId: text("step_id").notNull(),
    attempt: integer("attempt").notNull(),
    status: text("status").notNull().default("running"),
    input: jsonb("input"),
    output: jsonb("output"),
    error: jsonb("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("agent_steps_idempotency_idx").on(t.runId, t.stepId, t.attempt),
    index("agent_steps_run_idx").on(t.runId, t.id),
  ],
);

/**
 * Outbound effects staged inside a step's commit transaction (ADR-0014:
 * "action staging for outbound effects"). A separate dispatcher worker
 * (added alongside real integrations in m7) reads `pending` rows and
 * fires them with the staged idempotency key. Until then, rows are
 * inert — proving the runtime can stage but not yet act.
 */
export const pendingActions = pgTable(
  "pending_actions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("act")),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    stepId: text("step_id").notNull(),
    attempt: integer("attempt").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("pending"),
    result: jsonb("result"),
    error: jsonb("error"),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("pending_actions_idem_idx").on(t.idempotencyKey),
    index("pending_actions_status_idx")
      .on(t.status, t.id)
      .where(sql`${t.status} = 'pending'`),
  ],
);

/**
 * Durable, structured "why this decision" records (ADR-0077, closes #219).
 *
 * The motivating incidents (#210/#211/#212) were each found by a manual prod
 * SQL audit — self-ingestion ran ~9 days before a human noticed. The full
 * structured context that explains a triage tag already exists, but it was
 * `JSON.stringify`'d into a transient `agent.progress` event, never persisted.
 * This table is where it lands: one row per traced decision, queryable where
 * the audits already run.
 *
 * Kind-agnostic by design — the executor persists `(kind, trace)` without
 * inspecting the payload; the typed surface is `ctx.trace`, generic over the
 * `DecisionTraceRegistry` in `@alfred/api`. `trace` is plain `jsonb` (matching
 * the variable-shape `pending_actions.payload` / `agent_run_context.value`,
 * not the fixed-shape `transcript`).
 *
 * Forensic, not aggregate: drift metrics read the source-of-truth tables and
 * raise the flag; these rows explain it when an operator drills in. A retried
 * attempt writes distinct rows (the `attempt` is part of the unique key), so a
 * re-run within the same attempt is `onConflictDoNothing`. No retention
 * machinery v1 (volume ~3k rows/mo; CASCADE cleans up on run/user delete) —
 * revisit if volume grows.
 */
export const agentDecisionTraces = pgTable(
  "agent_decision_traces",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    /** Denormalized from the run for user-scoped drift slices without a join. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Denormalized from the run to filter traces by workflow. */
    workflowSlug: text("workflow_slug").notNull(),
    stepId: text("step_id").notNull(),
    attempt: integer("attempt").notNull(),
    /** Registry discriminator, e.g. `triage.classification`. */
    kind: text("kind").notNull(),
    /** The structured record (typed per-kind at the `ctx.trace` producer). */
    trace: jsonb("trace").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).defaultNow().notNull(),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("agent_decision_traces_idem_idx").on(t.runId, t.stepId, t.attempt, t.kind),
    index("agent_decision_traces_user_kind_idx").on(t.userId, t.kind, t.decidedAt),
    index("agent_decision_traces_workflow_kind_idx").on(t.workflowSlug, t.kind, t.decidedAt),
  ],
);

/**
 * Boss/sub-agent shared state per ADR-0016 namespaced scratchpad.
 * Schema-only at m5 — boss/sub-agent topology lands in m13. Including
 * the table now keeps a future migration small and lets steps read/write
 * it via a thin helper without reshaping the runtime later.
 *
 * Keys are dotted: `shared.user_facts`, `scratch.{sub_id}.summary`.
 * The dispatcher (not the model) enforces that sub-agents only write to
 * their own `scratch.{sub_id}.*` zone.
 */
export const agentRunContext = pgTable(
  "agent_run_context",
  {
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    zone: text("zone").notNull(),
    value: jsonb("value").notNull(),
    writtenBy: text("written_by").notNull(),
    writtenAt: timestamp("written_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("agent_run_context_pk_idx").on(t.runId, t.key),
    index("agent_run_context_zone_idx").on(t.runId, t.zone),
  ],
);

export type AgentRun = typeof agentRuns.$inferSelect;
export type AgentStep = typeof agentSteps.$inferSelect;
export type PendingAction = typeof pendingActions.$inferSelect;
export type AgentRunContextRow = typeof agentRunContext.$inferSelect;
export type AgentDecisionTrace = typeof agentDecisionTraces.$inferSelect;
