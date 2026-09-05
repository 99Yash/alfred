import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createId, inList, lifecycle_dates } from "../helpers";
import { user } from "./auth";

/**
 * Every logical kind of email Alfred sends. This is the source of truth for
 * `email_sends.kind`; `@alfred/assistant` imports the type for its `notify` surface.
 */
export const NOTIFICATION_KINDS = [
  "briefing",
  "evening_recap",
  "approval",
  "skill_documented",
  "health_alert",
  "workflow_blocked",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** `queued` on insert, then `sent` on Resend success or `failed` on error. */
export const EMAIL_SEND_STATUSES = ["queued", "sent", "failed"] as const;
export type EmailSendStatus = (typeof EMAIL_SEND_STATUSES)[number];

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
    /** Logical kind — one of `NOTIFICATION_KINDS`. */
    kind: text("kind").$type<NotificationKind>().notNull(),
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
    status: text("status").$type<EmailSendStatus>().notNull().default("queued"),
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
    check("email_sends_kind_valid", sql`${t.kind} IN (${inList(NOTIFICATION_KINDS)})`),
    check("email_sends_status_valid", sql`${t.status} IN (${inList(EMAIL_SEND_STATUSES)})`),
  ],
);

export type EmailSend = typeof emailSends.$inferSelect;
