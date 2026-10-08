import type {
  BriefingGather,
  BriefingClosedLoop,
  BriefingSendDecision,
  BriefingSlot,
  BriefingStatus,
  FullBriefing,
  IanaTimezone,
} from "@alfred/contracts";
import { sql } from "drizzle-orm";
import {
  boolean,
  date,
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
import { emailSends } from "./notifications";

/**
 * One briefing per (user, briefing_date, slot) (ADR-0041, ADR-0048).
 * The unique key blocks a duplicate compose. A failed row retries in place.
 * `briefing_date` uses string mode so it stays `YYYY-MM-DD`, not a JS `Date`.
 */
export const briefings = pgTable(
  "briefings",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("brg")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** YYYY-MM-DD in the user's timezone. */
    briefingDate: date("briefing_date", { mode: "string" }).notNull(),
    /** Morning may suppress. Evening always sends. */
    slot: text("slot").notNull().default("morning").$type<BriefingSlot>(),
    timezone: text("timezone").notNull().$type<IanaTimezone>(),
    status: text("status").notNull().default("pending").$type<BriefingStatus>(),
    /** Cut-off this briefing read up to. Only `sent` and `suppressed` rows move the next window. */
    watermarkAt: timestamp("watermark_at", { withTimezone: true }),
    /** Composer input. NULL until the gather step runs. A NULL inside it means one source is missing. */
    gather: jsonb("gather").$type<BriefingGather>(),
    /** Closed loops given to the composer. */
    closedLoops: jsonb("closed_loops")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<BriefingClosedLoop[]>(),
    breakingSummary: text("breaking_summary"),
    fullBriefing: jsonb("full_briefing").$type<FullBriefing>(),
    model: text("model"),
    /** True when the compose model failed and fallback prose was sent. */
    composeFallback: boolean("compose_fallback").notNull().default(false),
    /** NULL before the gate runs. Only the morning slot can be `suppressed`. */
    sendDecision: text("send_decision").$type<BriefingSendDecision>(),
    gateReason: text("gate_reason"),
    emailSendId: text("email_send_id").references(() => emailSends.id, {
      onDelete: "set null",
    }),
    /** No FK on purpose. */
    agentRunId: text("agent_run_id"),
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("briefings_user_date_slot_idx").on(t.userId, t.briefingDate, t.slot),
    // Replicache pull: newest briefings first.
    index("briefings_user_date_desc_idx").on(t.userId, t.briefingDate.desc(), t.slot),
    // Excludes `composed`: only terminal states move the watermark.
    index("briefings_watermark_idx")
      .on(t.userId, t.slot, t.watermarkAt)
      .where(sql`${t.status} in ('sent', 'suppressed')`),
  ],
);

export type Briefing = typeof briefings.$inferSelect;

export type NewBriefing = typeof briefings.$inferInsert;
