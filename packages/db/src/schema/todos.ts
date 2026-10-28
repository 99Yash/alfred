import type {
  AttributionAuthorityRef,
  TodoAttribution,
  TodoCause,
  TodoSource,
} from "@alfred/contracts";
import {
  ATTRIBUTION_ACTORS,
  ATTRIBUTION_AUTHORITIES,
  ATTRIBUTION_POLICY_CODES,
  TODO_CAUSES,
  TODO_CREATED_BY,
  TODO_EXECUTORS,
  TODO_KINDS,
  TODO_STATUSES,
  type AttributionActor,
  type AttributionAuthority,
  type TodoCreatedBy,
  type TodoExecutor,
  type TodoKind,
  type TodoStatus,
} from "@alfred/contracts";
import { sql } from "drizzle-orm";
import { check, date, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { createId, inList, lifecycle_dates } from "../helpers";
import { agentRuns } from "./agent";
import { user } from "./auth";

/**
 * Todos in the rail (ADR-0050). `suggested` rows are Alfred's proposals;
 * accepting one sets it to `open`. `executor`, `kind`, `position`, and `due_date`
 * are placeholders for later features.
 */
export const todos = pgTable(
  "todos",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("todo")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("open").$type<TodoStatus>(),
    /** Kept on promotion, so the accept rate stays measurable. */
    createdBy: text("created_by").notNull().default("user").$type<TodoCreatedBy>(),
    executor: text("executor").notNull().default("user").$type<TodoExecutor>(),
    kind: text("kind").notNull().default("task").$type<TodoKind>(),
    /** Alfred's tip on how to approach the item. */
    assist: text("assist"),
    /** One todo can come from many sources. `suggest_todo` dedups on `(provider, kind, id)`. */
    sources: jsonb("sources")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<TodoSource[]>(),
    agentRunId: text("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    /**
     * The ADR-0115 record of this write. Each insert, and each update that changes `status`,
     * `name`, or `due_date`, must set it, or the trigger raises. The trigger moves it to
     * `todo_events` and clears it on the next update, so code never reads it.
     */
    attribution: jsonb("attribution").$type<TodoAttribution>(),
    /** Done rows sync for 2 days after this. */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    position: integer("position"),
    dueDate: date("due_date", { mode: "string" }),
    /** Replicache version. Bump on every change. */
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [
    index("todos_user_status_idx").on(t.userId, t.status),
    index("todos_user_completed_idx").on(t.userId, t.completedAt),
    check("todos_status_valid", sql`${t.status} IN (${inList(TODO_STATUSES)})`),
    check("todos_kind_valid", sql`${t.kind} IN (${inList(TODO_KINDS)})`),
    check("todos_created_by_valid", sql`${t.createdBy} IN (${inList(TODO_CREATED_BY)})`),
    check("todos_executor_valid", sql`${t.executor} IN (${inList(TODO_EXECUTORS)})`),
  ],
);

export type Todo = typeof todos.$inferSelect;

/**
 * Append-only history for `todos`: creation, status changes, and edits of `name` or `due_date`.
 * Only the `todos` triggers write it, from the ADR-0115 record on the write.
 * Another trigger blocks UPDATE and direct DELETE; FK cascades still work.
 * `from_status` is null for the row that records creation.
 *
 * A row with a `cause` is an ADR-0115 row. Its checks enforce the rules of
 * `attributionRecordSchema`: the actor's authorities, the agent's action ids, and the one ref
 * shape for each authority. A row without a `cause` is from before ADR-0115 and has no record.
 * Each check is wrapped in COALESCE, because a CHECK that evaluates to NULL passes.
 */
export const todoEvents = pgTable(
  "todo_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("tev")),
    todoId: text("todo_id")
      .notNull()
      .references(() => todos.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    fromStatus: text("from_status").$type<TodoStatus>(),
    toStatus: text("to_status").notNull().$type<TodoStatus>(),
    actor: text("actor").notNull().$type<AttributionActor>(),
    /** Free text. Only rows from before ADR-0115 have it; later rows use `cause` and `note`. */
    reason: text("reason"),
    // ADR-0115 record. Null on rows from before it: readers show "not recorded".
    authority: text("authority").$type<AttributionAuthority>(),
    /** Persisted jsonb. `todo_events_authority_ref_valid` enforces the shape for its `authority`. */
    authorityRef: jsonb("authority_ref").$type<AttributionAuthorityRef>(),
    /** No FK, so the history outlives run retention. */
    runId: text("run_id"),
    toolCallId: text("tool_call_id"),
    cause: text("cause").$type<TodoCause>(),
    note: text("note"),
    nameBefore: text("name_before"),
    nameAfter: text("name_after"),
    dueDateBefore: date("due_date_before", { mode: "string" }),
    dueDateAfter: date("due_date_after", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("todo_events_todo_idx").on(t.todoId, t.createdAt),
    index("todo_events_user_idx").on(t.userId, t.createdAt),
    check("todo_events_to_status_valid", sql`${t.toStatus} IN (${inList(TODO_STATUSES)})`),
    check(
      "todo_events_from_status_valid",
      sql`(${t.fromStatus} IS NULL) OR (${t.fromStatus} IN (${inList(TODO_STATUSES)}))`,
    ),
    check("todo_events_actor_valid", sql`${t.actor} IN (${inList(ATTRIBUTION_ACTORS)})`),
    check(
      "todo_events_authority_valid",
      sql`(${t.authority} IS NULL) OR (${t.authority} IN (${inList(ATTRIBUTION_AUTHORITIES)}))`,
    ),
    check(
      "todo_events_cause_valid",
      sql`(${t.cause} IS NULL) OR (${t.cause} IN (${inList(TODO_CAUSES)}))`,
    ),
    check(
      "todo_events_unattributed_bare",
      sql`(${t.cause} IS NOT NULL) OR (${t.authority} IS NULL AND ${t.authorityRef} IS NULL AND ${t.runId} IS NULL AND ${t.toolCallId} IS NULL AND ${t.note} IS NULL)`,
    ),
    check(
      "todo_events_actor_authority_valid",
      sql`COALESCE((${t.cause} IS NULL)
        OR (${t.actor} = 'user' AND ${t.authority} = 'user_direct')
        OR (${t.actor} = 'agent' AND (${t.authority} IS NULL OR ${t.authority} <> 'user_direct'))
        OR (${t.actor} = 'system' AND ${t.authority} IN ('instruction', 'policy')), false)`,
    ),
    check(
      "todo_events_agent_action_valid",
      sql`COALESCE((${t.cause} IS NULL) OR CASE WHEN ${t.actor} = 'agent'
        THEN length(${t.runId}) > 0 AND length(${t.toolCallId}) > 0
        ELSE ${t.runId} IS NULL AND ${t.toolCallId} IS NULL END, false)`,
    ),
    check(
      "todo_events_authority_ref_valid",
      sql`COALESCE((${t.cause} IS NULL) OR CASE
        WHEN ${t.authority} IS NULL OR ${t.authority} = 'user_direct' THEN ${t.authorityRef} IS NULL
        WHEN jsonb_typeof(${t.authorityRef}) IS DISTINCT FROM 'object' THEN false
        WHEN ${t.authority} = 'user_request' THEN ${t.authorityRef}->>'kind' = 'message'
          AND jsonb_typeof(${t.authorityRef}->'id') = 'string' AND ${t.authorityRef}->>'id' <> ''
          AND ${t.authorityRef} - 'kind' - 'id' = '{}'::jsonb
        WHEN ${t.authority} = 'instruction' THEN ${t.authorityRef}->>'kind' = 'instruction'
          AND jsonb_typeof(${t.authorityRef}->'id') = 'string' AND ${t.authorityRef}->>'id' <> ''
          AND ${t.authorityRef} - 'kind' - 'id' - 'revision' = '{}'::jsonb
          AND CASE
            WHEN ${t.authorityRef}->'revision' IS NULL THEN true
            WHEN jsonb_typeof(${t.authorityRef}->'revision') <> 'number' THEN false
            ELSE (${t.authorityRef}->>'revision')::numeric >= 0
              AND (${t.authorityRef}->>'revision')::numeric = trunc((${t.authorityRef}->>'revision')::numeric)
          END
        WHEN ${t.authority} = 'policy' THEN ${t.authorityRef}->>'kind' = 'policy'
          AND jsonb_typeof(${t.authorityRef}->'code') = 'string'
          AND ${t.authorityRef}->>'code' IN (${inList(ATTRIBUTION_POLICY_CODES)})
          AND ${t.authorityRef} - 'kind' - 'code' = '{}'::jsonb
        ELSE false END, false)`,
    ),
  ],
);

export type TodoEvent = typeof todoEvents.$inferSelect;

export type NewTodoEvent = typeof todoEvents.$inferInsert;
