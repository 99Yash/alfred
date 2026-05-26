import type { BriefingGather, BriefingStatus, FullBriefing, IanaTimezone } from "@alfred/contracts";
import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { createId, lifecycle_dates } from "../helpers";
import { user } from "./auth";
import { emailSends } from "./notifications";

/**
 * Daily briefing — one row per (user, briefing_date). ADR-0041.
 *
 * Coexists with the legacy `briefing_runs` table (watermark + slot model)
 * during cutover; the morning-briefing workflow flips writes here in
 * Phase 6. The legacy table stays read-only diagnostic until a later
 * milestone drops it.
 *
 * Idempotency is enforced at the data layer this time: `UNIQUE(user_id,
 * briefing_date)` short-circuits a duplicate compose. A failed row can
 * be retried in place — status walks back through the gathering →
 * composing → sent machine; the unique key prevents a parallel insert.
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
      .$defaultFn(() => createId("brf")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Local-date this briefing is *for* (YYYY-MM-DD in user tz). */
    briefingDate: date("briefing_date", { mode: "string" }).notNull(),
    /** IANA timezone the briefing was rendered in. Branded string from contracts. */
    timezone: text("timezone").notNull().$type<IanaTimezone>(),
    /** 'pending' | 'gathering' | 'composing' | 'sent' | 'failed'. */
    status: text("status").notNull().default("pending").$type<BriefingStatus>(),
    /** Cross-source gather payload (composer input). Null sources are part of the schema. */
    gather: jsonb("gather").notNull().$type<BriefingGather>(),
    /** Short above-the-fold prose (composer output). Empty string until composed. */
    breakingSummary: text("breaking_summary").notNull().default(""),
    /** Full briefing prose + section structure (composer output). */
    fullBriefing: jsonb("full_briefing").notNull().$type<FullBriefing>(),
    /** Compose model id (e.g. 'claude-opus-4-7'). Null until composed. */
    model: text("model"),
    /** FK to the email_sends row that delivered this briefing. Null until sent. */
    emailSendId: text("email_send_id").references(() => emailSends.id, {
      onDelete: "set null",
    }),
    /** Replicache row-version. Bumped on every status / body change. */
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [
    // Idempotency key — one briefing per (user, calendar day in their tz).
    uniqueIndex("briefings_user_date_idx").on(t.userId, t.briefingDate),
    // Replicache pull window: "last N briefings for this user, newest first."
    index("briefings_user_date_desc_idx").on(t.userId, t.briefingDate.desc()),
  ],
);
