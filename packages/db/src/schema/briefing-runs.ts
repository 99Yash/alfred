import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createId, lifecycle_dates } from "../helpers";
import { user } from "./auth";

/**
 * Legacy archive of composed briefing runs. `briefings` replaced it (ADR-0048).
 * No live code reads or writes it. It stays to keep old data without a destructive migration.
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
    slot: text("slot").notNull(),
    /** YYYY-MM-DD in the user's timezone. */
    briefingDate: text("briefing_date").notNull(),
    runAt: timestamp("run_at", { withTimezone: true }).defaultNow().notNull(),
    /** Last `documents.ingested_at` this run read. The next run read strictly after it. */
    watermarkAt: timestamp("watermark_at", { withTimezone: true }),
    /** 'composing' | 'composed' | 'failed' */
    status: text("status").notNull().default("composing"),
    subject: text("subject"),
    bodyText: text("body_text"),
    bodyMarkdown: text("body_markdown"),
    /** Diagnostics only. */
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** No FK on purpose. */
    agentRunId: text("agent_run_id"),
    modelId: text("model_id"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    error: text("error"),
    ...lifecycle_dates,
  },
  (t) => [
    // No live query uses these indexes.
    index("briefing_runs_user_run_at_idx").on(t.userId, t.runAt),
    index("briefing_runs_watermark_idx")
      .on(t.userId, t.slot, t.runAt)
      .where(sql`${t.status} = 'composed'`),
    // Partial, so a retry after a failed row does not conflict.
    uniqueIndex("briefing_runs_user_slot_date_idx")
      .on(t.userId, t.slot, t.briefingDate)
      .where(sql`${t.status} = 'composed'`),
  ],
);

export type { BriefingSlot } from "@alfred/contracts";

export type BriefingRun = typeof briefingRuns.$inferSelect;
