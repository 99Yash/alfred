import { sql } from "drizzle-orm";
import {
  boolean,
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
 * A markdown body the agent mounts into its prompt (ADR-0017).
 * `learn-skill` writes v1; `skill-documentation` writes v2 from deeper search.
 * Each writes a `skill_revisions` row.
 */
export const skills = pgTable(
  "skills",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("skl")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Null until the first Learn run commits a body. */
    currentRevisionId: text("current_revision_id"),
    status: text("status").notNull().default("draft"),
    isBuiltin: boolean("is_builtin").notNull().default(false),
    lastInvokedAt: timestamp("last_invoked_at", { withTimezone: true }),
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("skills_slug_idx").on(t.userId, t.slug),
    index("skills_user_status_idx").on(t.userId, t.status, t.updatedAt),
  ],
);

/** Append-only skill bodies. `kind` is distilled, documented, or manual. */
export const skillRevisions = pgTable(
  "skill_revisions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("skr")),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    body: text("body").notNull(),
    /** Run notes (mentions, timestamps, token counts). The shape depends on `kind`. */
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** `agent_runs.id`. Null for `manual`. */
    createdByRunId: text("created_by_run_id"),
    rowVersion: integer("row_version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("skill_revisions_skill_idx").on(t.skillId, t.createdAt),
    index("skill_revisions_user_idx").on(t.userId, t.createdAt),
    // One revision per (skill, run), so a retried commit does not append a duplicate.
    // Manual edits have no run id and are not limited.
    uniqueIndex("skill_revisions_run_idx")
      .on(t.skillId, t.createdByRunId)
      .where(sql`${t.createdByRunId} IS NOT NULL`),
  ],
);

/** One row per Learn click. Feeds the History tab. */
export const skillRuns = pgTable(
  "skill_runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("sklrn")),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** learn | document. */
    kind: text("kind").notNull(),
    /** `agent_runs.id`, the source of truth for cost and errors. */
    agentRunId: text("agent_run_id").notNull(),
    /** Copy of `agent_runs.status`, updated on terminal transitions. */
    status: text("status").notNull().default("pending"),
    /** Set on success only. */
    producedRevisionId: text("produced_revision_id"),
    rowVersion: integer("row_version").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    index("skill_runs_skill_idx").on(t.skillId, t.startedAt),
    index("skill_runs_user_kind_idx").on(t.userId, t.kind, t.startedAt),
    uniqueIndex("skill_runs_agent_run_idx").on(t.agentRunId),
  ],
);

export type Skill = typeof skills.$inferSelect;

export type SkillRevision = typeof skillRevisions.$inferSelect;

export type SkillRun = typeof skillRuns.$inferSelect;
