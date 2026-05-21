import { index, pgTable, real, text, timestamp } from "drizzle-orm/pg-core";
import { lifecycle_dates } from "../helpers";
import { user } from "./auth";
import { documents } from "./documents";

/**
 * Email triage classifications (ADR-0025 #1).
 *
 * One row per document, keyed on `document_id`. Re-classification (e.g. on
 * reply) overwrites in place — the canonical alfred-label is always the
 * latest classification's outcome. Per-attempt audit lives in `api_call_log`
 * (the metered LLM call) and `agent_runs` (the workflow run that produced
 * the row), so we don't keep a separate history table.
 *
 * Why a dedicated table rather than `documents.metadata` jsonb:
 *  - we want to query "all docs awaiting reply" by category cheaply;
 *  - foreign-key cascades give us automatic cleanup when a document is
 *    deleted (Gmail purge, account disconnect);
 *  - `model` + `classified_at` are useful even when the document itself
 *    hasn't changed.
 */
export const emailTriage = pgTable(
  "email_triage",
  {
    documentId: text("document_id")
      .primaryKey()
      .references(() => documents.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
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
     * Gmail label id we wrote back ({@link emailTriage.category} → label id).
     * Stored so re-classification can remove the previous label without
     * re-fetching the credential's label cache.
     */
    appliedLabelId: text("applied_label_id"),
    classifiedAt: timestamp("classified_at", { withTimezone: true }).defaultNow().notNull(),
    /** Pointer to the originating `agent_runs.id`. */
    runId: text("run_id"),
    ...lifecycle_dates,
  },
  (t) => [
    index("email_triage_user_category_idx").on(t.userId, t.category, t.classifiedAt),
    index("email_triage_user_classified_idx").on(t.userId, t.classifiedAt),
  ],
);
