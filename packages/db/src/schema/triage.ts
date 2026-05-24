import { index, pgTable, primaryKey, real, text, timestamp } from "drizzle-orm/pg-core";
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
    /** Model identifier (`gemini-2.5-flash`, `claude-haiku-4-5`, …). */
    model: text("model").notNull(),
    /**
     * Gmail label id currently applied to the latest message in this
     * thread ({@link emailTriage.category} → label id). Stored so the
     * label-write step knows what to remove on re-classification.
     */
    appliedLabelId: text("applied_label_id"),
    /** Soft pointer to the latest classified `documents.id`. No FK. */
    documentId: text("document_id"),
    classifiedAt: timestamp("classified_at", { withTimezone: true }).defaultNow().notNull(),
    /** Pointer to the originating `agent_runs.id`. */
    runId: text("run_id"),
    ...lifecycle_dates,
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.sourceThreadId] }),
    index("email_triage_user_category_idx").on(t.userId, t.category, t.classifiedAt),
    index("email_triage_user_classified_idx").on(t.userId, t.classifiedAt),
  ],
);
