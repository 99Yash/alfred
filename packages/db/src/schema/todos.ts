import type { TodoSource } from "@alfred/contracts";
import {
  TODO_CREATED_BY,
  TODO_EXECUTORS,
  TODO_KINDS,
  TODO_RESOLVED_BY,
  TODO_STATUSES,
  type TodoCreatedBy,
  type TodoExecutor,
  type TodoKind,
  type TodoResolvedBy,
  type TodoStatus,
} from "@alfred/contracts";
import { sql } from "drizzle-orm";
import { check, date, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { createId, inList, lifecycle_dates } from "../helpers";
import { agentRuns } from "./agent";
import { user } from "./auth";

/**
 * Todos (ADR-0050) — a user-managed list of commitments, surfaced in the
 * right-hand quick rail. The first *persisted* materialization of the
 * open-loop model ADR-0048 keeps ephemeral: a todo is the user's opt-in to
 * persist one cross-source loop and track it to completion.
 *
 * One status-driven table (not a todos + suggestions pair, unlike dimension):
 * `suggested` rows are Alfred's proposals, `open` is live, `done`/`dismissed`
 * are terminal. Promotion (`+`) is a one-field `suggested → open` update.
 *
 * v1 is **passive**: `executor`/`kind` are forward-compat columns held inert
 * so the deferred agent-executable path (`executor='agent'`) lands without a
 * migration. `due_date`/`position` are forward-compat for scheduling +
 * manual reorder, neither wired at v1.
 *
 * `sources` is the cross-source provenance array (`TodoSource[]`) — multi-source
 * from day one so a row represents a real-world commitment, not one channel.
 * It is also the watch-list the deferred cross-source auto-close state machine
 * would consume.
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
    /** Short imperative title shown on the checkbox row. */
    name: text("name").notNull(),
    /** Optional longer body. */
    description: text("description"),
    /** 'suggested' | 'open' | 'done' | 'dismissed'. */
    status: text("status").notNull().default("open").$type<TodoStatus>(),
    /** 'user' | 'agent' — survives promotion so acceptance is measurable later. */
    createdBy: text("created_by").notNull().default("user").$type<TodoCreatedBy>(),
    /** Forward-compat: 'user' in passive v1; 'agent' is the deferred runtime-backed path. */
    executor: text("executor").notNull().default("user").$type<TodoExecutor>(),
    /** Forward-compat: 'task' in v1; executor-specific variants later. */
    kind: text("kind").notNull().default("task").$type<TodoKind>(),
    /**
     * Optional Alfred-authored tip on how to approach the item, degrading to
     * an honest "I can't act on this" when Alfred is clueless. Not execution.
     */
    assist: text("assist"),
    /**
     * Typed cross-source provenance: `[{ provider, kind, id, url? }]`.
     * Canonical identity is `(provider, kind, id)`; the `suggest_todo` tool
     * dedups + merges against it.
     */
    sources: jsonb("sources")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<TodoSource[]>(),
    /** Soft pointer to the agent run that proposed this row (traceability). */
    agentRunId: text("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    /**
     * Who last moved the row to its current status (`user` | `agent` | `system`).
     * NULL on a freshly minted row that has never transitioned. Every status
     * write sets it: UI mutators write `user`, `system.resolve_todo` /
     * `system.remember` dismissal writes `agent`, the automatic
     * `close-loop-todos` retraction writes `system`. Read with the status —
     * this is the answer to "who cleared this?".
     */
    resolvedBy: text("resolved_by").$type<TodoResolvedBy>(),
    /**
     * Caller-supplied audit label for the transition (e.g. `reply`,
     * `standing_instruction_sender_suppression`, or the model-authored
     * `system.resolve_todo` reason). Free text, bounded at the tool boundary;
     * echoed into `todo_events` by the transition trigger.
     */
    resolvedReason: text("resolved_reason"),
    /** Set when status flips to 'done'. Drives the 2-day done sync window. */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Forward-compat: manual drag-reorder. No interaction wired at v1. */
    position: integer("position"),
    /** Forward-compat: due date. No scheduling/rollover built at v1. */
    dueDate: date("due_date", { mode: "string" }),
    /** Replicache row-version. Bumped on every status/body change. */
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [
    // Replicache pull: "this user's live + recently-done + suggested todos."
    index("todos_user_status_idx").on(t.userId, t.status),
    // Done-window prune lookup (status='done' AND completed_at >= now()-7d).
    index("todos_user_completed_idx").on(t.userId, t.completedAt),
    check("todos_status_valid", sql`${t.status} IN (${inList(TODO_STATUSES)})`),
    check("todos_kind_valid", sql`${t.kind} IN (${inList(TODO_KINDS)})`),
    check("todos_created_by_valid", sql`${t.createdBy} IN (${inList(TODO_CREATED_BY)})`),
    check("todos_executor_valid", sql`${t.executor} IN (${inList(TODO_EXECUTORS)})`),
    check(
      "todos_resolved_by_valid",
      sql`(${t.resolvedBy} IS NULL) OR (${t.resolvedBy} IN (${inList(TODO_RESOLVED_BY)}))`,
    ),
  ],
);

export type Todo = typeof todos.$inferSelect;

/**
 * Append-only transition history for `todos` (#1177). One row per status
 * change, written by the `todos_log_transition` trigger from the row's own
 * `resolved_by` / `resolved_reason` — the application never inserts here
 * directly, and the `todo_events_no_update_delete` trigger rejects UPDATE
 * and direct DELETE (FK-cascade from a user/todo wipe is allowed so owner
 * deletion and test cleanup keep working). `from_status` is NULL on the
 * insert row (the mint itself is recorded by the trigger).
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
    /** Who caused the transition (`user` | `agent` | `system`). */
    actor: text("actor").notNull().$type<TodoResolvedBy>(),
    /** Audit label carried over from `todos.resolved_reason`. */
    reason: text("reason"),
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
    check("todo_events_actor_valid", sql`${t.actor} IN (${inList(TODO_RESOLVED_BY)})`),
  ],
);

export type TodoEvent = typeof todoEvents.$inferSelect;

export type NewTodoEvent = typeof todoEvents.$inferInsert;
