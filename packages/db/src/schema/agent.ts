import type { AgentTranscriptMessage } from "@alfred/contracts";
import {
  TERMINAL_RUN_STATUSES,
  agentRunTriggerSchema,
  type AgentRunTrigger,
  type EventSource,
  type EventType,
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
} from "drizzle-orm/pg-core";
import { createId, lifecycle_dates } from "../helpers";
import { user } from "./auth";
import { workflowRevisions } from "./workflows";

export { agentRunTriggerSchema };
export type { AgentRunTrigger };

/**
 * Name of the partial unique index that enforces one non-terminal chat turn
 * per (user, thread). Exported so the turn-kick catch can match the exact
 * constraint name on a 23505 and distinguish a "thread busy" collision from a
 * same-user-message double-submit (which trips the dedup index instead). See
 * the index definition below and issue #488.
 */
export const CHAT_THREAD_ACTIVE_RUN_INDEX = "agent_runs_chat_thread_active_idx";

/**
 * Name of the partial unique index that enforces one non-terminal run per
 * inbound event identity. Exported so `emitEvent`'s catch can match the exact
 * constraint name on a 23505 and count the losing insert as a dropped duplicate
 * rather than a failure. See the index definition below and issue #531.
 */
export const EVENT_ACTIVE_RUN_INDEX = "agent_runs_event_active_idx";

/**
 * Name of the partial unique index behind `Workflow.dedupKey` (singleton runs).
 * Exported for the same reason as the two above: a caller that owns several
 * unique invariants has to know WHICH one collided. An event dispatch can trip
 * this one instead of {@link EVENT_ACTIVE_RUN_INDEX} whenever the target
 * workflow also declares a dedup key, and both mean "a run for this already
 * exists" — not "the dispatch failed".
 */
export const RUN_DEDUP_KEY_INDEX = "agent_runs_dedup_key_idx";
export const MANUAL_REQUEST_RUN_INDEX = "agent_runs_manual_request_idx";

/**
 * The `agent_runs` unique indexes whose constraint name a caller has to *branch
 * on*, i.e. the ones with more than one 23505 in reach.
 *
 * `agent_runs_sub_agent_dedup_idx` is deliberately absent: its one caller
 * (`spawnSubAgent`) matches any 23505 and then re-reads the winning row, so it
 * never needs to know which constraint fired. Adding a fourth index that a
 * caller *does* discriminate means adding it here — and then declaring its
 * collision meaning below becomes a build requirement.
 */
export const AGENT_RUN_UNIQUE_INDEXES = [
  EVENT_ACTIVE_RUN_INDEX,
  RUN_DEDUP_KEY_INDEX,
  MANUAL_REQUEST_RUN_INDEX,
  CHAT_THREAD_ACTIVE_RUN_INDEX,
] as const;

export type AgentRunUniqueIndex = (typeof AGENT_RUN_UNIQUE_INDEXES)[number];

/**
 * What a 23505 on each index *means* to the losing writer, and therefore what it
 * owes the caller:
 *
 * - `duplicate` — "a run for this already exists"; the losing write is dropped
 *   silently and counted, not reported as a failure.
 * - `busy` — "the resource is occupied by a different request"; the loser is a
 *   distinct request that must be surfaced, never swallowed.
 *
 * Declared as data and checked exhaustively, for the same reason `RUN_STATUS_KIND`
 * is: a `readonly string[]` set plus a prose note about which index is
 * deliberately excluded gives a fourth index zero prompting, and `.includes(typo)`
 * compiles when the element type is `string`. Getting this wrong is not loud — an
 * event dispatch onto a workflow that ALSO declares a `dedupKey` can collide on
 * either index depending on which write loses, and a caller that checks only one
 * of them logs an error for a benign outcome (#530/#531 review, D7).
 *
 * The axis is whether the colliding key identifies the *request* or the
 * *resource*:
 *
 * - {@link EVENT_ACTIVE_RUN_INDEX} is the inbound event's identity — a webhook
 *   and its retry are the same request by construction.
 * - {@link RUN_DEDUP_KEY_INDEX} is request identity too, and the workflow itself
 *   declared it: the key is whatever its `dedupKey(input)` returns. A singleton
 *   like cold-start-research returns a constant, so two dispatches carrying
 *   *different* events really are one request by that workflow's own definition
 *   ("run me once, whatever wakes me") — the dropped event is intended, not lost.
 *   That is the semantic, and `emitEvent` counting the drop as `skippedDuplicate`
 *   is correct rather than a mislabel. Its partial predicate agrees: it keeps
 *   `completed` rows blocking (unlike the other two), because the answer it gives
 *   is "already done", not "busy right now".
 * - {@link CHAT_THREAD_ACTIVE_RUN_INDEX} is resource occupancy, and no workflow
 *   asked for it — the key is the thread, and the two turns contending for it are
 *   genuinely different requests with different `userMessageId`s. Dropping the
 *   loser as a duplicate would swallow a message the user typed, so it surfaces
 *   as a typed "thread busy" instead (#488).
 */
const AGENT_RUN_UNIQUE_INDEX_MEANING = {
  [EVENT_ACTIVE_RUN_INDEX]: "duplicate",
  [RUN_DEDUP_KEY_INDEX]: "duplicate",
  [MANUAL_REQUEST_RUN_INDEX]: "duplicate",
  [CHAT_THREAD_ACTIVE_RUN_INDEX]: "busy",
} as const satisfies Record<AgentRunUniqueIndex, "duplicate" | "busy">;

/**
 * Does this 23505's constraint mean "a run for this already exists, drop the
 * loser"? Derived from {@link AGENT_RUN_UNIQUE_INDEX_MEANING}, so the set and the
 * reasoning behind it cannot drift apart.
 *
 * Takes the constraint name as `string | null` because that is what
 * `uniqueViolationConstraint` returns, and narrows — so a caller gets the
 * null-check and the membership test in one call instead of hand-writing both.
 */
export function isDuplicateRunIndex(constraint: string | null): constraint is AgentRunUniqueIndex {
  return (
    constraint !== null &&
    constraint in AGENT_RUN_UNIQUE_INDEX_MEANING &&
    AGENT_RUN_UNIQUE_INDEX_MEANING[constraint as AgentRunUniqueIndex] === "duplicate"
  );
}

/**
 * `status NOT IN (<terminal statuses>)` — the one non-terminal run predicate.
 *
 * Four sites need it: the two partial indexes below, `hasNonTerminalEventRun`,
 * and the chat active-run read. Two of those (the event index and the query it
 * backs) have to agree exactly or the index quietly stops being the race-safe
 * boundary, and none of them can be checked by the type system. Built from
 * `TERMINAL_RUN_STATUSES`, which is derived from the same exhaustive map as
 * `isTerminalStatus`, so a new run status reaches every one of them at once.
 *
 * The cost of rendering it into DDL: this function's *output text* is what
 * drizzle-kit diffs a partial index on, and the list order it interpolates is
 * `runStatusSchema`'s declaration order. Adding a terminal status, or reordering
 * that enum, rewrites the predicate of both partial indexes below and
 * regenerates them as DROP/CREATE. Append to the enum, never permute it — and
 * when the predicate does have to change, read the generated migration before
 * applying it rather than assuming the diff is empty.
 */
export function runIsNotTerminal(status: SQLWrapper): SQL {
  // Inlined as SQL literals rather than bound parameters: this fragment also
  // renders into partial-index DDL, and drizzle-kit emits `$1, $2, $3` there
  // with nothing to bind them to. Safe to inline because every value is a
  // static member of `runStatusSchema`, never caller input.
  const statuses = TERMINAL_RUN_STATUSES.map((s) => `'${s}'`).join(", ");
  return sql`${status} NOT IN (${sql.raw(statuses)})`;
}

/** The dedup identity of an inbound event's run (#531). */
export interface EventRunIdentity {
  userId: string;
  workflowSlug: string;
  source: EventSource;
  type: EventType;
  eventId: string;
  /** Absent for an original delivery; set for a re-key (e.g. the #282 reply re-eval). */
  reason?: string | undefined;
}

/** The `agent_runs` columns an event identity is read from. */
interface EventRunIdentityColumns {
  userId: SQLWrapper;
  workflowSlug: SQLWrapper;
  status: SQLWrapper;
  trigger: SQLWrapper;
}

/**
 * The ordered parts of an event run's identity — the single definition that
 * generates BOTH {@link EVENT_ACTIVE_RUN_INDEX}'s key and the identity half of
 * `hasNonTerminalEventRun`'s WHERE. The index only enforces what the query
 * looks for if the two are expression-for-expression identical; writing the
 * tuple out twice and asserting "keep these byte-identical" in a comment is
 * exactly the index-vs-query drift this list removes. Trigger construction is a
 * separate boundary, validated by `agentRunTriggerSchema`; this list does not
 * generate that object.
 *
 * Every jsonb part is `coalesce`d to `''`. `agentRunTriggerSchema` marks
 * `source`/`type` optional (tolerant reads of pre-ADR-0047 rows), and a unique
 * index treats NULLs as distinct — so a bare `->> 'source'` key column would
 * hand any trigger written without them *zero* enforcement, silently. The one
 * uncoalesced part is `eventId`, and the index predicate excludes NULL eventIds
 * outright, so no shape reaches the index unenforced.
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

/** Index-key expressions for {@link EVENT_ACTIVE_RUN_INDEX}, in key order. */
function eventRunIdentityKey(t: EventRunIdentityColumns): [SQL, ...SQL[]] {
  const [first, ...rest] = EVENT_RUN_IDENTITY_PARTS.map((part) => part.expr(t));
  if (!first) throw new Error("[db] event run identity has no key columns");
  return [first, ...rest];
}

/**
 * WHERE for "this user already has a non-terminal run for this exact event" —
 * the read `emitEvent` uses as its fast path, generated from the same parts as
 * the index that enforces it.
 */
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
    /**
     * The `workflow_revisions.id` this run pinned when its occurrence was
     * claimed (#555). The run keeps executing that definition even after the
     * user edits the workflow, so a long unattended run can never change
     * contract mid-flight. Null for built-ins, chat turns, and every row
     * written before revisions existed.
     */
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
    foreignKey({
      name: "agent_runs_workflow_revision_owner_fk",
      columns: [t.workflowRevisionId, t.userId],
      foreignColumns: [workflowRevisions.id, workflowRevisions.userId],
    }),
    index("agent_runs_user_idx").on(t.userId, t.status),
    index("agent_runs_runnable_idx")
      .on(t.lastCheckpointAt)
      .where(sql`${t.status} IN ('pending', 'runnable', 'running')`),
    // Enforces "at most one active run per (user, workflow, dedup_key)."
    // Excludes failed/cancelled so a transient outage doesn't permanently
    // lock a workflow out — a later trigger can produce a fresh attempt.
    // Workflows opt in by declaring `dedupKey` on their definition; rows
    // with a null dedup key are unaffected (most workflows).
    uniqueIndex(RUN_DEDUP_KEY_INDEX)
      .on(t.userId, t.workflowSlug, t.dedupKey)
      .where(sql`${t.dedupKey} IS NOT NULL AND ${t.status} NOT IN ('failed', 'cancelled')`),
    // Sub-agent spawns are idempotent per parent tool call, including after a
    // child terminal-fails. The general dedup index deliberately excludes
    // failed/cancelled rows so chat turns stay retryable; this narrower index
    // keeps duplicate `system.spawn_sub_agent` side effects from creating a
    // second child for the same parent call once the first child has already
    // left the active-index predicate.
    uniqueIndex("agent_runs_sub_agent_dedup_idx")
      .on(t.userId, t.workflowSlug, t.dedupKey)
      .where(sql`${t.workflowSlug} = '__user-authored-brief__' AND ${t.dedupKey} LIKE 'sub:%'`),
    // Manual/test retries remain one occurrence after every terminal outcome.
    // The general dedup index intentionally permits failed/cancelled retries;
    // caller-supplied manual request ids do not, because they identify the same
    // occurrence rather than a request to try the workflow again.
    uniqueIndex(MANUAL_REQUEST_RUN_INDEX)
      .on(t.userId, t.workflowSlug, t.dedupKey)
      .where(sql`(${t.trigger} ->> 'kind') = 'manual' AND ${t.dedupKey} LIKE 'manual:%'`),
    // Enforces "at most one non-terminal run per (user, workflow, event
    // identity)" (#531). The duplicate check is a read followed by an insert,
    // so two
    // concurrent dispatches of the same event (a webhook and its retry, or a
    // webhook and a poll) both read zero matches and both create a run —
    // duplicate triage/brief, duplicate model spend, duplicate side effects.
    // The general dedup index can't catch it: event-triggered runs return a
    // null `dedup_key`, and that index only fires on non-null. This is the
    // race-safe boundary, mirroring how the chat path uses
    // CHAT_THREAD_ACTIVE_RUN_INDEX: the losing insert hits a 23505 and
    // `emitEvent` drops it as a duplicate. Both the key and the query it
    // enforces come from EVENT_RUN_IDENTITY_PARTS — including `reason`, which
    // deliberately makes an outbound-reply re-eval (#282) a *different* event
    // from the original delivery. The NULL eventId exclusion is what lets the
    // key's one uncoalesced part be safe (see the parts list).
    uniqueIndex(EVENT_ACTIVE_RUN_INDEX)
      .on(...eventRunIdentityKey(t))
      .where(
        sql`(${t.trigger} ->> 'kind') = 'event' AND (${t.trigger} ->> 'eventId') IS NOT NULL AND ${runIsNotTerminal(t.status)}`,
      ),
    // Enforces "at most one non-terminal chat turn per (user, thread)" (#488).
    // The chat-turn workflow keeps its thread id in `metadata.threadId`, so this
    // indexes that jsonb expression. The dedup index above is keyed on
    // `userMessageId` and only stops an *exact* double-submit; a genuinely new
    // turn (fresh userMessageId) on a thread whose prior run is still in flight
    // slips past it. This index is the race-safe boundary the turn kick relies
    // on: two concurrent kicks with different user messages both try to insert,
    // one wins, the loser hits a 23505 on THIS constraint and is translated to a
    // typed "thread busy" response. `completed` is excluded (unlike the dedup
    // index) so the next turn is admitted once the prior run reaches any
    // terminal state.
    uniqueIndex(CHAT_THREAD_ACTIVE_RUN_INDEX)
      .on(t.userId, sql`(${t.metadata} ->> 'threadId')`)
      .where(
        sql`${t.workflowSlug} = '__chat-turn__' AND (${t.metadata} ->> 'threadId') IS NOT NULL AND ${runIsNotTerminal(t.status)}`,
      ),
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
 * Durable, structured "why this decision" records (PR-A of #219).
 *
 * The motivating incidents (#210/#211/#212) were each found by a manual prod
 * SQL audit — self-ingestion ran ~9 days before a human noticed. The full
 * structured context that explains a triage tag already exists, but it was
 * `JSON.stringify`'d into an untyped `agent.progress` event payload instead of
 * a first-class queryable row. This table is where it lands: one row per traced
 * decision, queryable where the audits already run.
 *
 * Kind-agnostic by design — the runtime persists `(kind, decision_key, trace)`
 * without inspecting the payload; the typed surface is `ctx.trace`, generic
 * over the `DecisionTraceRegistry` in `@alfred/api`. Domain stores may also
 * insert the same keyed trace inside a domain-row transaction when row+trace
 * atomicity matters; the unique key makes the later executor insert a no-op.
 * `trace` is plain `jsonb` (matching the variable-shape
 * `pending_actions.payload` / `agent_run_context.value`, not the fixed-shape
 * `transcript`).
 *
 * Forensic, not aggregate: drift metrics read the source-of-truth tables and
 * raise the flag; these rows explain it when an operator drills in. A retried
 * attempt writes distinct rows (the `attempt` is part of the unique key), while
 * `decision_key` separates multiple decisions of the same kind inside one step.
 * A re-run within the same trace slot is `onConflictDoNothing`. No retention
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
    /** Stable per-step discriminator for multiple traces of the same kind. */
    decisionKey: text("decision_key").notNull(),
    /** The structured record (typed per-kind at the `ctx.trace` producer). */
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
