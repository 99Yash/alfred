import type { AgentTranscriptMessage } from "@alfred/contracts";
import {
  TERMINAL_RUN_STATUSES,
  agentRunTriggerSchema,
  type AgentRunTrigger,
  type EventSource,
  type EventType,
  type WorkflowRunOutcome,
} from "@alfred/contracts";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  bigserial,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createId, lifecycle_dates } from "../helpers";
import { user } from "./auth";
import { workflowRevisions } from "./workflows";

export { agentRunTriggerSchema };

export type { AgentRunTrigger };

/** One non-terminal chat turn per (user, thread). A 23505 here means "thread busy", not a double-submit. */
export const CHAT_THREAD_ACTIVE_RUN_INDEX = "agent_runs_chat_thread_active_idx";

/** One non-terminal run per inbound event identity. A 23505 here is a dropped duplicate. */
export const EVENT_ACTIVE_RUN_INDEX = "agent_runs_event_active_idx";

/**
 * The index behind `Workflow.dedupKey`. An event dispatch can trip this one
 * instead of {@link EVENT_ACTIVE_RUN_INDEX}; both mean "a run already exists".
 */
export const RUN_DEDUP_KEY_INDEX = "agent_runs_dedup_key_idx";

export const MANUAL_REQUEST_RUN_INDEX = "agent_runs_manual_request_idx";

export const OCCURRENCE_RUN_INDEX = "agent_runs_occurrence_idx";

/**
 * Unique indexes whose name a caller branches on after a 23505.
 * `agent_runs_sub_agent_dedup_idx` is absent: its caller re-reads the winner on any 23505.
 */
export const AGENT_RUN_UNIQUE_INDEXES = [
  OCCURRENCE_RUN_INDEX,
  EVENT_ACTIVE_RUN_INDEX,
  RUN_DEDUP_KEY_INDEX,
  MANUAL_REQUEST_RUN_INDEX,
  CHAT_THREAD_ACTIVE_RUN_INDEX,
] as const;

export type AgentRunUniqueIndex = (typeof AGENT_RUN_UNIQUE_INDEXES)[number];

/**
 * What a 23505 on each index means to the losing writer.
 * `duplicate`: the key names the request, so drop the loser silently.
 * `busy`: the key names a resource held by a different request, so surface it.
 * A chat loser is a new user message, so dropping it would lose what the user typed.
 */
const AGENT_RUN_UNIQUE_INDEX_MEANING = {
  [OCCURRENCE_RUN_INDEX]: "duplicate",
  [EVENT_ACTIVE_RUN_INDEX]: "duplicate",
  [RUN_DEDUP_KEY_INDEX]: "duplicate",
  [MANUAL_REQUEST_RUN_INDEX]: "duplicate",
  [CHAT_THREAD_ACTIVE_RUN_INDEX]: "busy",
} as const satisfies Record<AgentRunUniqueIndex, "duplicate" | "busy">;

/** True when this 23505 constraint means "a run already exists, drop the loser". */
export function isDuplicateRunIndex(constraint: string | null): constraint is AgentRunUniqueIndex {
  return (
    constraint !== null &&
    constraint in AGENT_RUN_UNIQUE_INDEX_MEANING &&
    // SAFETY: the `in` check above proves constraint is a key of the record.
    AGENT_RUN_UNIQUE_INDEX_MEANING[constraint as AgentRunUniqueIndex] === "duplicate"
  );
}

/**
 * `status NOT IN (<terminal statuses>)`. The partial indexes and the queries they
 * back must use this one predicate, or the index stops enforcing the query.
 * The output renders into index DDL in `runStatusSchema` order. Append to that enum, never reorder it.
 */
export function runIsNotTerminal(status: SQLWrapper): SQL {
  // Literals, not parameters: index DDL has nothing to bind `$1` to. Values are static enum members.
  const statuses = TERMINAL_RUN_STATUSES.map((s) => `'${s}'`).join(", ");

  return sql`${status} NOT IN (${sql.raw(statuses)})`;
}

/** Lives here because {@link CHAT_THREAD_ACTIVE_RUN_INDEX} renders it into DDL. */
export const CHAT_TURN_WORKFLOW_SLUG = "__chat-turn__";

interface ChatThreadRunColumns {
  userId: SQLWrapper;
  workflowSlug: SQLWrapper;
  metadata: SQLWrapper;
}

/** Thread id expression shared by {@link CHAT_THREAD_ACTIVE_RUN_INDEX} and every thread query. */
function chatThreadIdExpr(t: Pick<ChatThreadRunColumns, "metadata">): SQL {
  return sql`(${t.metadata} ->> 'threadId')`;
}

/** `workflow_slug = '__chat-turn__'`, inlined so it can render into index DDL. */
function isChatTurnRun(t: Pick<ChatThreadRunColumns, "workflowSlug">): SQL {
  return sql`${t.workflowSlug} = ${sql.raw(`'${CHAT_TURN_WORKFLOW_SLUG}'`)}`;
}

/** WHERE for the chat-turn runs of one thread, built from the same expressions as the index. */
export function chatThreadRunMatch(
  t: ChatThreadRunColumns,
  identity: { userId: string; threadId: string },
): SQL {
  return sql.join(
    [
      sql`${t.userId} = ${identity.userId}`,
      isChatTurnRun(t),
      sql`${chatThreadIdExpr(t)} = ${identity.threadId}`,
    ],
    sql` AND `,
  );
}

export interface EventRunIdentity {
  userId: string;
  workflowSlug: string;
  source: EventSource;
  type: EventType;
  eventId: string;
  /** Set only to re-key a delivery as a new event, e.g. a reply re-eval. */
  reason?: string | undefined;
}

interface EventRunIdentityColumns {
  userId: SQLWrapper;
  workflowSlug: SQLWrapper;
  status: SQLWrapper;
  trigger: SQLWrapper;
}

/**
 * Event run identity. Builds both {@link EVENT_ACTIVE_RUN_INDEX}'s key and the
 * matching query, so the two cannot drift.
 * Parts are `coalesce`d to `''` because a unique index treats NULLs as distinct.
 * `eventId` is not: the index predicate already excludes a NULL eventId.
 */
const EVENT_RUN_IDENTITY_PARTS: readonly {
  expr: (t: EventRunIdentityColumns) => SQL;
  value: (identity: EventRunIdentity) => string;
}[] = [
  { expr: (t) => sql`${t.userId}`, value: (id) => id.userId },
  { expr: (t) => sql`${t.workflowSlug}`, value: (id) => id.workflowSlug },
  { expr: (t) => sql`coalesce(${t.trigger} ->> 'source', '')`, value: (id) => id.source },
  { expr: (t) => sql`coalesce(${t.trigger} ->> 'type', '')`, value: (id) => id.type },
  { expr: (t) => sql`(${t.trigger} ->> 'eventId')`, value: (id) => id.eventId },
  {
    expr: (t) => sql`coalesce(${t.trigger} -> 'payload' ->> 'reason', '')`,
    value: (id) => id.reason ?? "",
  },
];

function eventRunIdentityKey(t: EventRunIdentityColumns): [SQL, ...SQL[]] {
  const [first, ...rest] = EVENT_RUN_IDENTITY_PARTS.map((part) => part.expr(t));

  if (!first) throw new Error("[db] event run identity has no key columns");

  return [first, ...rest];
}

/** WHERE for "a non-terminal run for this exact event exists". */
export function eventRunIdentityMatch(t: EventRunIdentityColumns, identity: EventRunIdentity): SQL {
  return sql.join(
    [
      sql`(${t.trigger} ->> 'kind') = 'event'`,
      runIsNotTerminal(t.status),
      ...EVENT_RUN_IDENTITY_PARTS.map((part) => sql`${part.expr(t)} = ${part.value(identity)}`),
    ],
    sql` AND `,
  );
}

/**
 * Writer shape for a run or step `error`. `.$type` does not validate reads,
 * so keep it wide enough for every writer. `cancelledBy` exists only on old rows.
 */
export type AgentError = {
  message: string;
  step?: string;
  attempt?: number;
  reason?: string;
  cancelledBy?: string;
};

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
    /** Pinned revision, so a user edit cannot change a run mid-flight. Null for built-ins and chat turns. */
    workflowRevisionId: text("workflow_revision_id"),
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
    /** Cancel fence. A cancel bumps it; a step commit or dispatch with an older value is refused. */
    cancellationGeneration: integer("cancellation_generation").notNull().default(0),
    wakeCondition: jsonb("wake_condition"),
    error: jsonb("error").$type<AgentError>(),
    /** Written with the terminal status. Reads still parse it with `workflowRunOutcomeSchema`. */
    outcome: jsonb("outcome").$type<WorkflowRunOutcome>(),
    output: jsonb("output"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** What caused the run (ADR-0027). Replaces `metadata.triggeredBy`. Null only on legacy rows. */
    trigger: jsonb("trigger").$type<AgentRunTrigger>(),
    /** Identity of one cron, event, manual, or replay occurrence. */
    occurrenceKey: text("occurrence_key"),
    replayOfRunId: text("replay_of_run_id").references((): AnyPgColumn => agentRuns.id),
    deferredUntil: timestamp("deferred_until", { withTimezone: true }),
    /** Workflow-declared singleton key, enforced by `RUN_DEDUP_KEY_INDEX`. */
    dedupKey: text("dedup_key"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    lastCheckpointAt: timestamp("last_checkpoint_at", { withTimezone: true }),
    ...lifecycle_dates,
  },
  (t) => [
    foreignKey({
      name: "agent_runs_workflow_revision_owner_fk",
      columns: [t.workflowRevisionId, t.userId],
      foreignColumns: [workflowRevisions.id, workflowRevisions.userId],
    }),
    index("agent_runs_workflow_history_idx").on(
      t.userId,
      t.workflowSlug,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    index("agent_runs_user_idx").on(t.userId, t.status),
    index("agent_runs_runnable_idx")
      .on(t.lastCheckpointAt)
      .where(sql`${t.status} IN ('pending', 'runnable', 'running')`),
    index("agent_runs_deferred_idx")
      .on(t.deferredUntil)
      .where(sql`${t.status} = 'deferred'`),
    uniqueIndex(OCCURRENCE_RUN_INDEX).on(t.userId, t.occurrenceKey),
    // `completed` still blocks ("already done").
    // Failed/cancelled do not, so an outage cannot lock a workflow out.
    uniqueIndex(RUN_DEDUP_KEY_INDEX)
      .on(t.userId, t.workflowSlug, t.dedupKey)
      .where(sql`${t.dedupKey} IS NOT NULL AND ${t.status} NOT IN ('failed', 'cancelled')`),
    // One child per parent tool call, even after that child fails. The general index lets failed rows retry.
    uniqueIndex("agent_runs_sub_agent_dedup_idx")
      .on(t.userId, t.workflowSlug, t.dedupKey)
      .where(sql`${t.workflowSlug} = '__user-authored-brief__' AND ${t.dedupKey} LIKE 'sub:%'`),
    // Finds the children of a parent run, for cancel cascades and child listing.
    index("agent_runs_sub_agent_parent_idx")
      .on(t.userId, sql`(${t.metadata} -> 'subAgent' ->> 'parentRunId')`)
      .where(sql`(${t.metadata} -> 'subAgent' ->> 'parentRunId') IS NOT NULL`),
    // A manual request id is one occurrence, so it blocks a rerun even after failure.
    uniqueIndex(MANUAL_REQUEST_RUN_INDEX)
      .on(t.userId, t.workflowSlug, t.dedupKey)
      .where(sql`(${t.trigger} ->> 'kind') = 'manual' AND ${t.dedupKey} LIKE 'manual:%'`),
    // The read-then-insert check races (a webhook and its retry both read zero).
    // This index is the race-safe boundary. Event runs have a null `dedup_key`,
    // so the index above misses them.
    uniqueIndex(EVENT_ACTIVE_RUN_INDEX)
      .on(...eventRunIdentityKey(t))
      .where(
        sql`(${t.trigger} ->> 'kind') = 'event' AND (${t.trigger} ->> 'eventId') IS NOT NULL AND ${runIsNotTerminal(t.status)}`,
      ),
    // The dedup index stops only an exact double-submit. This one stops a new turn while the prior turn runs.
    uniqueIndex(CHAT_THREAD_ACTIVE_RUN_INDEX)
      .on(t.userId, chatThreadIdExpr(t))
      .where(
        sql`${isChatTurnRun(t)} AND ${chatThreadIdExpr(t)} IS NOT NULL AND ${runIsNotTerminal(t.status)}`,
      ),
  ],
);

/**
 * One row per step attempt. `(run_id, step_id, attempt)` is the idempotency key
 * for billable calls (ADR-0014). Inserted as `running` before the body runs;
 * recovery from a stale `running` row adds a new attempt.
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
    error: jsonb("error").$type<AgentError>(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("agent_steps_idempotency_idx").on(t.runId, t.stepId, t.attempt),
    index("agent_steps_run_idx").on(t.runId, t.id),
  ],
);

/** Outbound effects staged in a step's commit transaction (ADR-0014). No dispatcher reads them yet. */
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
    index("pending_actions_run_idx").on(t.runId),
    index("pending_actions_status_idx")
      .on(t.status, t.id)
      .where(sql`${t.status} = 'pending'`),
  ],
);

/**
 * One queryable "why this decision" record per traced decision.
 * The runtime does not read `trace`; `ctx.trace` types it per kind.
 * A domain store may insert the same keyed trace first; the unique key makes the executor's insert a no-op.
 */
export const agentDecisionTraces = pgTable(
  "agent_decision_traces",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workflowSlug: text("workflow_slug").notNull(),
    stepId: text("step_id").notNull(),
    attempt: integer("attempt").notNull(),
    /** e.g. `triage.classification`. */
    kind: text("kind").notNull(),
    /** Separates several traces of one kind in one step. */
    decisionKey: text("decision_key").notNull(),
    trace: jsonb("trace").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).defaultNow().notNull(),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("agent_decision_traces_idem_idx").on(
      t.runId,
      t.stepId,
      t.attempt,
      t.kind,
      t.decisionKey,
    ),
    index("agent_decision_traces_user_kind_idx").on(t.userId, t.kind, t.decidedAt),
    index("agent_decision_traces_workflow_kind_idx").on(t.workflowSlug, t.kind, t.decidedAt),
  ],
);

/**
 * Boss and sub-agent scratchpad (ADR-0016). Keys are dotted, e.g. `scratch.{sub_id}.summary`.
 * The dispatcher, not the model, keeps a sub-agent inside its own `scratch.{sub_id}.*` zone.
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
