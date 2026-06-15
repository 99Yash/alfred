import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createId, lifecycle_dates } from "../helpers";
import { user } from "./auth";

/**
 * Legacy-only composed-run archive. ADR-0048 makes `briefings` the
 * canonical slotted entity and moves terminal watermarks there. Keep this
 * table only for diagnostics and the in-flight legacy `daily-briefing`
 * smoke path until the follow-up migration drops it.
 *
 * One row per composed briefing. Two roles in one table:
 *
 *   1. Watermark store. `watermark_at` is the `documents.ingested_at`
 *      cut-off this run consumed; the next run for the same `(user_id,
 *      slot)` reads `WHERE ingested_at > watermark_at`. Using
 *      `ingested_at` (not `authored_at`) matches `gatherBriefingDigest` —
 *      threaded emails can carry an old Date header but what matters is
 *      "what alfred saw since the last briefing."
 *
 *   2. Composed-body archive. `body_text` is read back by future
 *      briefing runs as part of the prompt context — that's how an
 *      evening briefing can say "morning mentioned the Deepanshu
 *      follow-up..." without re-deriving from the inbox. The agent
 *      reads its own prior output, not chat history.
 *
 * `slot` is the only place we distinguish morning from evening at the
 * data layer; the workflow + agent are otherwise shared.
 *
 * Idempotency rides on `email_sends.(user_id, idempotency_key)` per
 * ADR-0020 — `briefing_runs` itself does not enforce one-per-day. A
 * smoke run forcing a re-compose is legitimate (different watermark,
 * different body); the duplicate-send guard is downstream.
 */
export const briefingRuns = pgTable(
  "briefing_runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("brf")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** 'morning' | 'evening'. New slots (e.g. 'midday') can land without a migration. */
    slot: text("slot").notNull(),
    /** Local-date this run is *for* (YYYY-MM-DD in user tz). Same shape as the idempotency-key day-segment. */
    briefingDate: text("briefing_date").notNull(),
    /** Wall-clock when the run actually composed. */
    runAt: timestamp("run_at", { withTimezone: true }).defaultNow().notNull(),
    /**
     * Upper bound of `documents.ingested_at` this run consumed; the next
     * run for the same `(user_id, slot)` reads strictly greater. Null
     * before the agent finishes (status='composing').
     */
    watermarkAt: timestamp("watermark_at", { withTimezone: true }),
    /** 'composing' | 'composed' | 'failed'. */
    status: text("status").notNull().default("composing"),
    /** Composed body — read by future runs as prompt context. */
    subject: text("subject"),
    bodyText: text("body_text"),
    /**
     * Markdown source of the composed body. The briefing agent emits
     * markdown; the email HTML is rendered from this at send time
     * (`@alfred/mailer`) and not archived here — `email_sends` records
     * the actual delivery, and a resend re-renders from this column.
     */
    bodyMarkdown: text("body_markdown"),
    /**
     * Free-form audit jsonb: tool-call counts, document ids cited,
     * meeting-prep / action-item refs surfaced. Not the source of truth
     * for any downstream read — diagnostics only.
     */
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Tied to the workflow run that produced this row (FK left soft to avoid a tight coupling). */
    agentRunId: text("agent_run_id"),
    modelId: text("model_id"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    /** Truncated error on failure. */
    error: text("error"),
    ...lifecycle_dates,
  },
  (t) => [
    // Most common read: "last N briefings for this user (any slot)" — used by the agent's
    // `list_prior_briefings` tool. Ordered descending in the query.
    index("briefing_runs_user_run_at_idx").on(t.userId, t.runAt),
    // Watermark lookup: "what was the latest composed briefing for this (user, slot)?"
    // Filtered to `composed` so a half-finished row doesn't poison the next watermark.
    index("briefing_runs_watermark_idx")
      .on(t.userId, t.slot, t.runAt)
      .where(sql`${t.status} = 'composed'`),
    // Soft uniqueness — same (user, slot, date) shouldn't have multiple composed rows.
    // Partial so retries on a failed row don't trip it. Cron + smoke + manual all hit this.
    uniqueIndex("briefing_runs_user_slot_date_idx")
      .on(t.userId, t.slot, t.briefingDate)
      .where(sql`${t.status} = 'composed'`),
  ],
);

export type { BriefingSlot } from "@alfred/contracts";
