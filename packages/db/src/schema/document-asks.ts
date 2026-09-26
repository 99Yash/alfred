import {
  DOCUMENT_ASK_KINDS,
  DOCUMENT_ASK_STATUSES,
  contentFormatValues,
  type ContentFormat,
  type DocumentAskEvidenceSource,
  type DocumentAskKind,
  type DocumentAskStatus,
} from "@alfred/contracts";
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createId, inList, lifecycle_dates } from "../helpers";
import { user } from "./auth";

/**
 * Durable user-owned work opened by an inbound Gmail request for a resume or
 * portfolio. The account-qualified source message is identity; the thread is
 * only a later-carrier matching relation. This table is deliberately separate
 * from the mutable thread-keyed triage projection and generic external objects.
 */
export const documentAsks = pgTable(
  "document_asks",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("dask")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Persisted connected Gmail account identity, not an email re-parsed here. */
    accountId: text("account_id").notNull(),
    /** The inbound Gmail message that authored the ask. */
    sourceMessageId: text("source_message_id").notNull(),
    /** Gmail thread used only to find later sent attachment carriers. */
    threadId: text("thread_id").notNull(),
    requestedKind: text("requested_kind").$type<DocumentAskKind>().notNull(),
    status: text("status").$type<DocumentAskStatus>().notNull().default("active"),
    /** Trusted authored time; null is retained but cannot pass a later-than gate. */
    askedAt: timestamp("asked_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedCarrierMessageId: text("resolved_carrier_message_id"),
    resolvedAttachmentDocumentId: text("resolved_attachment_document_id"),
    /** Exact occurrence and persisted-content identity used for the decision. */
    resolvedAttachmentId: text("resolved_attachment_id"),
    resolvedAttachmentContentHash: text("resolved_attachment_content_hash"),
    resolvedAttachmentFormat: text("resolved_attachment_format").$type<ContentFormat>(),
    resolvedContentKind: text("resolved_content_kind").$type<DocumentAskKind>(),
    /** Truthful local provenance for the accepted extracted-content observation. */
    resolvedEvidenceSource: text("resolved_evidence_source").$type<DocumentAskEvidenceSource>(),
    ...lifecycle_dates,
  },
  (t) => [
    check("document_asks_kind_valid", sql`${t.requestedKind} IN (${inList(DOCUMENT_ASK_KINDS)})`),
    check("document_asks_status_valid", sql`${t.status} IN (${inList(DOCUMENT_ASK_STATUSES)})`),
    check(
      "document_asks_resolution_coherent",
      sql`(
        ${t.status} = 'active'
        AND ${t.resolvedAt} IS NULL
        AND ${t.resolvedCarrierMessageId} IS NULL
        AND ${t.resolvedAttachmentDocumentId} IS NULL
        AND ${t.resolvedAttachmentId} IS NULL
        AND ${t.resolvedAttachmentContentHash} IS NULL
        AND ${t.resolvedAttachmentFormat} IS NULL
        AND ${t.resolvedContentKind} IS NULL
        AND ${t.resolvedEvidenceSource} IS NULL
      ) OR (
        ${t.status} = 'resolved'
        AND ${t.resolvedAt} IS NOT NULL
        AND ${t.resolvedCarrierMessageId} IS NOT NULL
        AND ${t.resolvedCarrierMessageId} <> ''
        AND ${t.resolvedAttachmentDocumentId} IS NOT NULL
        AND ${t.resolvedAttachmentDocumentId} <> ''
        AND ${t.resolvedAttachmentId} IS NOT NULL
        AND ${t.resolvedAttachmentId} <> ''
        AND ${t.resolvedAttachmentContentHash} IS NOT NULL
        AND ${t.resolvedAttachmentContentHash} <> ''
        AND ${t.resolvedAttachmentFormat} IS NOT NULL
        AND ${t.resolvedAttachmentFormat} IN (${inList(contentFormatValues)})
        AND ${t.resolvedContentKind} IS NOT NULL
        AND ${t.resolvedEvidenceSource} = 'extracted_content'
      )`,
    ),
    check(
      "document_asks_resolved_kind_matches",
      sql`${t.resolvedContentKind} IS NULL OR ${t.resolvedContentKind} = ${t.requestedKind}`,
    ),
    uniqueIndex("document_asks_source_identity_idx").on(t.userId, t.accountId, t.sourceMessageId),
    index("document_asks_active_thread_idx").on(
      t.userId,
      t.accountId,
      t.threadId,
      t.status,
      t.requestedKind,
    ),
  ],
);

export type DocumentAskRow = typeof documentAsks.$inferSelect;

export type NewDocumentAsk = typeof documentAsks.$inferInsert;
