import type {
  BriefingGather,
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
 * Daily briefing — one row per (user, briefing_date, slot). ADR-0041,
 * amended by ADR-0048.
 *
 * This is the canonical briefing entity. The legacy `briefing_runs`
 * table is diagnostic-only during cutover and should not receive new
 * product writes once the daily-briefing workflow is moved over.
 *
 * Idempotency is enforced at the data layer: `UNIQUE(user_id,
 * briefing_date, slot)` short-circuits a duplicate compose. A failed row
 * can be retried in place — status walks back through the gathering →
 * composing → composed → sent/suppressed machine; the unique key
 * prevents a parallel insert.
 *
 * `gather`, `full_briefing` are typed against `@alfred/contracts` via
 * `.$type<T>()` so the Replicache read schema and this row agree by
 * construction. `briefing_date` is `date({ mode: 'string' })` so the
 * column round-trips as `YYYY-MM-DD` without Drizzle injecting a JS
 * `Date` — keeps Eden treaty + Replicache pulls boring.
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
    /** Local-date this briefing is *for* (YYYY-MM-DD in user tz). */
    briefingDate: date("briefing_date", { mode: "string" }).notNull(),
    /** 'morning' | 'evening'. Morning may suppress; evening always sends. */
    slot: text("slot").notNull().default("morning").$type<BriefingSlot>(),
    /** IANA timezone the briefing was rendered in. Branded string from contracts. */
    timezone: text("timezone").notNull().$type<IanaTimezone>(),
    /** 'pending' | 'gathering' | 'composing' | 'composed' | 'sent' | 'suppressed' | 'failed'. */
    status: text("status").notNull().default("pending").$type<BriefingStatus>(),
    /**
     * Cut-off instant consumed by this terminal briefing. Only `sent` and
     * `suppressed` rows advance the next slot-scoped window.
     */
    watermarkAt: timestamp("watermark_at", { withTimezone: true }),
    /**
     * Cross-source gather payload (composer input). Null until the `gather`
     * step writes it; `status` is the source of truth for whether it's
     * populated. Per-source `null`s (no calendar consent, etc.) are part of
     * the `BriefingGather` shape itself, distinct from this column-level NULL.
     */
    gather: jsonb("gather").$type<BriefingGather>(),
    /** Short above-the-fold prose (composer output). Null until status is 'composed' or 'sent'. */
    breakingSummary: text("breaking_summary"),
    /** Full briefing prose + section structure (composer output). Null until status is 'composed' or 'sent'. */
    fullBriefing: jsonb("full_briefing").$type<FullBriefing>(),
    /** Compose model id (e.g. 'claude-opus-4-7'). Null until composed. */
    model: text("model"),
    /** True when deterministic fallback prose was delivered after compose-model failure. */
    composeFallback: boolean("compose_fallback").notNull().default(false),
    /**
     * Terminal gate outcome. Null before the gate runs; `suppressed` is
     * valid only for the morning slot.
     */
    sendDecision: text("send_decision").$type<BriefingSendDecision>(),
    /** Short human-readable explanation for a suppression or send gate decision. */
    gateReason: text("gate_reason"),
    /** FK to the email_sends row that delivered this briefing. Null until sent. */
    emailSendId: text("email_send_id").references(() => emailSends.id, {
      onDelete: "set null",
    }),
    /** Soft pointer to the agent run that produced this row. */
    agentRunId: text("agent_run_id"),
    /** Replicache row-version. Bumped on every status / body change. */
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [
    // Idempotency key — one briefing per (user, calendar day in their tz, slot).
    uniqueIndex("briefings_user_date_slot_idx").on(t.userId, t.briefingDate, t.slot),
    // Replicache pull window: "last N briefings for this user, newest first."
    index("briefings_user_date_desc_idx").on(t.userId, t.briefingDate.desc(), t.slot),
    // Slot-scoped delta lookup. `composed` is intentionally excluded: only
    // terminal consumed states move the next watermark forward.
    index("briefings_watermark_idx")
      .on(t.userId, t.slot, t.watermarkAt)
      .where(sql`${t.status} in ('sent', 'suppressed')`),
  ],
);

export type Briefing = typeof briefings.$inferSelect;
export type NewBriefing = typeof briefings.$inferInsert;
