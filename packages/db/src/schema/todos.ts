import type {
  TodoCreatedBy,
  TodoExecutor,
  TodoKind,
  TodoSource,
  TodoStatus,
} from "@alfred/contracts";
import { sql } from "drizzle-orm";
import { date, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { createId, lifecycle_dates } from "../helpers";
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
    /** Set when status flips to 'done'. Drives the 7-day done sync window. */
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
  ],
);
