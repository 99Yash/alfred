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
  boolean,
  check,
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
 * Each new message reclassifies and overwrites the row. History lives in `agent_runs`.
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
