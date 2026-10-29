import type {
  DocumentAskProposal,
  SignificanceBand,
  TriageCategory,
  TriageTagSource,
  TriageTodoDecision,
  TriageTodoSuggestion,
} from "@alfred/contracts";
import { TRIAGE_CATEGORIES } from "@alfred/contracts";
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { inList, lifecycle_dates } from "../helpers";
import { user } from "./auth";

/**
 * Email triage, one row per Gmail thread (ADR-0025).
 * Each new message reclassifies and overwrites the row. History lives in `agent_runs`, and a
 * re-match change in `email_triage_changes`.
 */
export const emailTriage = pgTable(
  "email_triage",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sourceThreadId: text("source_thread_id").notNull(),
    category: text("category").$type<TriageCategory>().notNull(),
    /** 0 to 1. */
    confidence: real("confidence").notNull(),
    rationale: text("rationale"),
    /** Proposal only. The durable ask lives in its own table. */
    documentAsk: jsonb("document_ask").$type<DocumentAskProposal>(),
    /** Stored so a retried `classify` can rebuild the result and mint a todo a crash lost. */
    todoSuggestion: jsonb("todo_suggestion").$type<TriageTodoSuggestion>(),
    /** Stored so a retry gates the todo the same way as the first attempt. */
    todoDecision: jsonb("todo_decision").$type<TriageTodoDecision>(),
    model: text("model").notNull(),
    /** Label last confirmed in Gmail. Null means Gmail may lag the category. */
    appliedLabelId: text("applied_label_id"),
    /** Latest classified `documents.id`. No FK, so purging one message keeps the thread's row. */
    documentId: text("document_id"),
    /** Lets the rail demote a thread inside its category, never retag it (ADR-0064). */
    senderSignificanceBand: text("sender_significance_band").$type<SignificanceBand>(),
    /**
     * The verdict after the system floors and before any standing-instruction effect
     * (ADR-0113). History: nothing rewrites it. `unknown`: read it with
     * `triageModelVerdictSchema`. `category`, `documentAsk`, and `todoSuggestion` above are the
     * cached effective result derived from it.
     */
    modelVerdict: jsonb("model_verdict"),
    /**
     * The instruction-set revision and the scoped match results the model returned for
     * `documentId` (ADR-0113). `unknown`: read it with `triageInstructionEvaluationSchema`.
     * Null means no evaluation, so every scoped instruction is `unknown`.
     */
    instructionEvaluation: jsonb("instruction_evaluation"),
    /** Stored because a retry does not regather context. Null reads as not cold. */
    senderRelationshipIsCold: boolean("sender_relationship_is_cold"),
    classifiedAt: timestamp("classified_at", { withTimezone: true }).defaultNow().notNull(),
    runId: text("run_id"),
    /** On a `user` row, `confidence` and `rationale` are stale. Do not show them. */
    source: text("source").notNull().default("auto").$type<TriageTagSource>(),
    /** Set only when `source = 'user'`. */
    overriddenAt: timestamp("overridden_at", { withTimezone: true }),
    /** Replicache version. Bump on every write. */
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.sourceThreadId] }),
    check("email_triage_category_valid", sql`${t.category} IN (${inList(TRIAGE_CATEGORIES)})`),
    index("email_triage_user_category_idx").on(t.userId, t.category, t.classifiedAt),
    index("email_triage_user_classified_idx").on(t.userId, t.classifiedAt),
  ],
);

export type EmailTriage = typeof emailTriage.$inferSelect;

/**
 * Each change that the re-match job writes to an `email_triage` row (ADR-0113, "History").
 * Append only. The classify run keeps its own history in `agent_decision_traces`; this table
 * holds the changes that no run made. Deleted with its triage row.
 */
export const emailTriageChanges = pgTable(
  "email_triage_changes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id").notNull(),
    sourceThreadId: text("source_thread_id").notNull(),
    /** The document that the scope results are for. */
    documentId: text("document_id").notNull(),
    /** The instruction-set revision that the job read. */
    setRevision: integer("set_revision").notNull(),
    /** The cached effective result before the change: category, ask, todo, todo decision. */
    previous: jsonb("previous").notNull(),
    /** The cached effective result after the change. */
    next: jsonb("next").notNull(),
    /** The scope results after the change, with the model's reason for each match. */
    scopes: jsonb("scopes").notNull(),
    /**
     * The instruction floor's audit: each effect with its instruction id, revision, match
     * kind, and scope reason. Null when the row has no model verdict.
     */
    floor: jsonb("floor"),
    changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: "email_triage_changes_triage_fk",
      columns: [t.userId, t.sourceThreadId],
      foreignColumns: [emailTriage.userId, emailTriage.sourceThreadId],
    }).onDelete("cascade"),
    index("email_triage_changes_thread_idx").on(t.userId, t.sourceThreadId, t.changedAt),
  ],
);

export type EmailTriageChange = typeof emailTriageChanges.$inferSelect;
