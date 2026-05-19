import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createId, lifecycle_dates, vectorColumn } from "../helpers";
import { user } from "./auth";

/**
 * One row per ingested object (email, calendar event, doc, slack message).
 * The (`source`, `source_id`) tuple is the provider-native identifier;
 * `(user_id, source, source_id)` is unique so re-ingesting is a no-op.
 *
 * Why one table, not per-source: ADR-0010 calls out a single `documents`
 * + `chunks` schema, source-tagged. Joins to ingestion-time metadata
 * (sender, attendees) live in `metadata` jsonb so the schema doesn't
 * grow per provider.
 */
export const documents = pgTable(
  "documents",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("doc")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** 'gmail', 'gcal', 'slack', 'linear', 'github', 'notion', 'imessage'. */
    source: text("source").notNull(),
    /** Provider-native id (Gmail message id, Slack ts, Linear issue id). */
    sourceId: text("source_id").notNull(),
    /** Thread/conversation grouping — Gmail threadId, Slack thread_ts. NULL for stand-alone docs. */
    sourceThreadId: text("source_thread_id"),
    /** Which connected account this came from — links to integration_credentials.account_id. */
    accountId: text("account_id"),
    title: text("title"),
    content: text("content").notNull(),
    /** sha256 hex digest of `content`; used by the chunker to skip re-embedding unchanged docs. */
    contentHash: text("content_hash").notNull(),
    /** Original payload (headers, raw MIME parts, full provider response) — for debugging + re-extraction. */
    raw: jsonb("raw"),
    url: text("url"),
    /** When the source was authored (email Date header, event start time, message ts). */
    authoredAt: timestamp("authored_at", { withTimezone: true }),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).defaultNow().notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("documents_source_id_idx").on(t.userId, t.source, t.sourceId),
    index("documents_user_source_idx").on(t.userId, t.source, t.authoredAt),
    index("documents_thread_idx").on(t.userId, t.source, t.sourceThreadId),
  ],
);

/**
 * Vector-searchable slice of a document. `embedding` is nullable —
 * m7a writes documents without chunks (raw ingestion only); m7b lands
 * the chunker + Voyage embedding pipeline that backfills this table.
 *
 * HNSW index is created in a separate migration step (Drizzle doesn't
 * model HNSW operator classes natively); see the migration SQL.
 */
export const chunks = pgTable(
  "chunks",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("chk")),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /** Denormalized so vector queries can filter by user_id without joining documents. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Order within the parent document (0-indexed). */
    position: integer("position").notNull(),
    content: text("content").notNull(),
    embedding: vectorColumn("embedding", 1024),
    tokenCount: integer("token_count"),
    contentHash: text("content_hash").notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("chunks_document_position_idx").on(t.documentId, t.position),
    index("chunks_user_idx").on(t.userId),
  ],
);
