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
    state: jsonb("state").notNull().default(sql`'{}'::jsonb`),
    currentStep: text("current_step").notNull(),
    attempt: integer("attempt").notNull().default(0),
    wakeCondition: jsonb("wake_condition"),
    error: jsonb("error"),
    output: jsonb("output"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
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
