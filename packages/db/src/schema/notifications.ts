import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createId, inList, lifecycle_dates } from "../helpers";
import { user } from "./auth";

/** Every kind of email Alfred sends. Source of truth for `email_sends.kind`. */
export const NOTIFICATION_KINDS = [
  "briefing",
  "evening_recap",
  "approval",
  "skill_documented",
  "health_alert",
  "delivery_alert",
  "workflow_blocked",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const EMAIL_SEND_STATUSES = ["queued", "sent", "failed"] as const;

export type EmailSendStatus = (typeof EMAIL_SEND_STATUSES)[number];

/**
 * Outbound email log and idempotency ledger (ADR-0020).
 * Rows go `queued` -> `sent` | `failed`. The `(user_id, idempotency_key)` index makes a repeat send a no-op.
 *
 * Keys:
 *   `briefing:{userId}:{local day}:{slot}`
 *   `approval:{stagingId}`
 *   `health_alert:{userId}:{metric}:{local day}`
 *   `delivery_alert:{userId}:{source}:{local day}` (ADR-0100)
 *
 * `delivery_alert` is its own kind because its sender reads a bounded page of recent rows
 * of that kind. Drift rows in the same kind could fill the page and hide the last alert.
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
    kind: text("kind").$type<NotificationKind>().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    toAddress: text("to_address").notNull(),
    subject: text("subject").notNull(),
    /** Not used yet. */
    template: text("template"),
    /** Render input, kept to debug or re-render a failed send. */
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text("status").$type<EmailSendStatus>().notNull().default("queued"),
    /** Resend's message id. */
    providerMessageId: text("provider_message_id"),
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
