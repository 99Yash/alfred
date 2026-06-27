import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createId, lifecycle_dates } from "../helpers";
import { user } from "./auth";

/**
 * Outbound email log + idempotency ledger (ADR-0020).
 *
 * Every email Alfred sends to the user (briefing, evening recap, approval
 * requests, …) lands here first as `status='queued'`, then transitions to
 * `'sent'` on Resend success or `'failed'` on error. The `(user_id,
 * idempotency_key)` unique index is what keeps cron-triggered sends safe:
 * a duplicate run with the same key inserts no row and returns
 * `status='duplicate'` to the caller without hitting Resend.
 *
 * Idempotency-key conventions:
 *   `briefing:{userId}:{YYYY-MM-DD-in-user-tz}:{slot}` — slotted briefing
 *   `approval:{userId}:{runId}:{stepId}`               — HIL approval ping
 *   `health_alert:{userId}:{metric}:{YYYY-MM-DD-in-user-tz}` — drift breach (≤1/metric/local day)
 *
 * `notification_preferences` (ADR-0020's per-kind channel routing) is
 * deliberately deferred. Every send today goes via email; once a second
 * channel exists (web push, Slack DM) we add the prefs table + the
 * `notify()` helper grows a fan-out branch.
 */
export const emailSends = pgTable(
  "email_sends",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("ems")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Logical kind: 'briefing', 'evening_recap', 'approval', etc. */
    kind: text("kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    toAddress: text("to_address").notNull(),
    subject: text("subject").notNull(),
    /** Optional template id when we move to reusable templates — null today. */
    template: text("template"),
    /** Render input — kept so a failed send can be re-rendered/debugged later. */
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** 'queued' → 'sent' | 'failed'. */
    status: text("status").notNull().default("queued"),
    /** Resend's message id, for cross-referencing in their dashboard. */
    providerMessageId: text("provider_message_id"),
    /** Truncated provider error on failure; null on success. */
    error: text("error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("email_sends_idem_idx").on(t.userId, t.idempotencyKey),
    index("email_sends_user_kind_idx").on(t.userId, t.kind, t.createdAt),
  ],
);

export type EmailSend = typeof emailSends.$inferSelect;
