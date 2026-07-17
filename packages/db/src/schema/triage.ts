import type {
  SignificanceBand,
  TriageTagSource,
  TriageTodoDecision,
  TriageTodoSuggestion,
} from "@alfred/contracts";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { lifecycle_dates } from "../helpers";
import { user } from "./auth";

/**
 * Email triage classifications (ADR-0025 #1).
 *
 * One row per Gmail thread (PK = `(user_id, source_thread_id)`). Each new
 * message in a thread re-runs the classifier and overwrites this row — the
 * canonical alfred-label is always the latest message's outcome. Per-attempt
 * audit lives in `api_call_log` (the metered LLM call) and `agent_runs`
 * (the workflow run), so we don't keep a per-message history table.
 *
 * `document_id` is a soft pointer to the latest classified Gmail message in
 * the thread — no FK, so a Gmail purge that wipes one message doesn't
 * cascade-delete the whole thread's classification. The next classification
 * cycle re-points it.
 *
 * Why a dedicated table rather than `documents.metadata` jsonb:
 *  - we want to query "all threads awaiting reply" by category cheaply;
 *  - `model` + `classified_at` are useful for audit/debug even when the
 *    thread itself hasn't changed.
 */
export const emailTriage = pgTable(
  "email_triage",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sourceThreadId: text("source_thread_id").notNull(),
    /**
     * One of `TRIAGE_CATEGORIES` (`urgent | action_needed | follow_up |
     * awaiting_reply | meeting | fyi | done | payment | newsletter |
     * marketing`). Stored as text (not pg enum) so adding a category is
     * a code-only change.
     */
    category: text("category").notNull(),
    /** [0, 1] — surfaced in the UI for low-confidence soft-confirms. */
    confidence: real("confidence").notNull(),
    /** Short rationale from the classifier (audit + debugging). */
    rationale: text("rationale"),
    /**
     * Classifier todo proposal (rule 16), persisted so a same-run `classify`
     * retry that takes the reuse path can reconstruct the full classification
     * and re-mint the rail todo a crashed first attempt never wrote (#157).
     * Null when the model proposed no todo, on user-overridden rows, and on
     * legacy rows written before this column existed.
     */
    todoSuggestion: jsonb("todo_suggestion").$type<TriageTodoSuggestion>(),
    /**
     * Always-present rubric trace from the classifier ({@link TriageTodoDecision}).
     * Persisted alongside `todoSuggestion` so the reuse path's reconstructed
     * classification gates `resolveTodoSuggestion` identically to the first
     * attempt (mint iff `outcome === 'proposed'`). Null on legacy/override rows.
     */
    todoDecision: jsonb("todo_decision").$type<TriageTodoDecision>(),
    /** Model identifier (`gemini-2.5-flash`, `claude-haiku-4-5`, …). */
    model: text("model").notNull(),
    /**
     * Gmail label id last confirmed by the shared relabel writer for the current
     * row. Null means the DB category may be newer than Gmail and still needs
     * reconciliation; relabel strips all Alfred-owned labels before applying one.
     */
    appliedLabelId: text("applied_label_id"),
    /** Soft pointer to the latest classified `documents.id`. No FK. */
    documentId: text("document_id"),
    /**
     * Sender-significance band at classify time (ADR-0064 / #210), bucketed from
     * the precomputed scalar (ADR-0057/0059). Synced to the rail so it can demote
     * a low-significance sender's thread *within* its honest, immutable category —
     * never re-tagging. Null when the sender is non-human / unscored / had no
     * graph row when the thread was last classified; the attention scorer reads
     * that null as neutral. Stale-tolerant: refreshed on the thread's next
     * classify, not on every significance pass.
     */
    senderSignificanceBand: text("sender_significance_band").$type<SignificanceBand>(),
    /**
     * Typed rule-16b cold-contact verdict at classify time, persisted so the
     * cold-sender todo gate is decided ONCE and owned by the row. A same-run
     * `classify` retry that takes the reuse path (#157 stale-lease reclaim) does
     * not re-gather observations, so without this it re-derived the verdict from
     * missing context and resurrected a suppressed cold todo. Reading it back keeps
     * the fresh and reuse paths identical. Null when the sender is non-human /
     * unscored / had no graph row, and on legacy rows written before this column —
     * all read as not-cold (keep the todo), never as suppress.
     */
    senderRelationshipIsCold: boolean("sender_relationship_is_cold"),
    classifiedAt: timestamp("classified_at", { withTimezone: true }).defaultNow().notNull(),
    /** Pointer to the originating `agent_runs.id`. */
    runId: text("run_id"),
    /**
     * Author of the current tag (rfc-triage-tags.md). `auto` = the classifier;
     * `user` = a `triageTagOverride` mutator. A `user` row's `confidence`/
     * `rationale` are stale classifier artifacts and must NOT be surfaced — the
     * synced `SyncedTriageTag` union hides them on the `user` branch.
     */
    source: text("source").notNull().default("auto").$type<TriageTagSource>(),
    /** Set iff `source = 'user'` (Invariant 4). Null for classifier-authored rows. */
    overriddenAt: timestamp("overridden_at", { withTimezone: true }),
    /** Replicache CVR row-version — bumped by every mutator + classifier write. */
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.sourceThreadId] }),
    index("email_triage_user_category_idx").on(t.userId, t.category, t.classifiedAt),
    index("email_triage_user_classified_idx").on(t.userId, t.classifiedAt),
  ],
);

export type EmailTriage = typeof emailTriage.$inferSelect;
