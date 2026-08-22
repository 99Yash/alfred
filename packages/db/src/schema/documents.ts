import { DOCUMENT_SOURCES, type DocumentSource } from "@alfred/contracts";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createId, inList, lifecycle_dates, vectorColumn } from "../helpers";
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
    source: text("source").$type<DocumentSource>().notNull(),
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
    /**
     * Embedding retry bookkeeping (poison-pill guard). A document with no
     * `chunks` rows is a candidate for the background embed sweep; without a
     * cap, one whose Voyage call keeps failing (or that has no embeddable
     * content) is re-selected every sweep forever. Count failures here and
     * dead-letter via `embedFailedAt` so the sweep gives up.
     */
    embedAttempts: integer("embed_attempts").notNull().default(0),
    /**
     * When embedding first started failing (set once, kept via COALESCE). The
     * transient dead-letter gate measures failure age from here rather than
     * from an attempt count: a 5-minute sweep would otherwise burn through an
     * attempt cap in ~25 minutes and permanently drop the whole backlog during
     * a routine provider outage. Cleared on a successful (re-)embed
     * (`EMBED_SUCCESS_RESET`) so the grace resets per failure-streak.
     */
    embedFirstFailedAt: timestamp("embed_first_failed_at", { withTimezone: true }),
    /**
     * Set when embedding is abandoned — a per-input-permanent error (400/413/422:
     * the input itself is un-embeddable), a transient/systemic failure that has
     * persisted past the retry window, or no embeddable content. A non-null value
     * excludes the row from the embed sweep. Rows are immutable, so a dead-lettered
     * doc stays dead unless deliberately retried: to resurrect, null BOTH this and
     * `embed_first_failed_at` (nulling this alone leaves a days-old first-failure
     * marker that re-dead-letters on the next blip).
     */
    embedFailedAt: timestamp("embed_failed_at", { withTimezone: true }),
    /** Bounded, secret-redacted last embed-failure message — ops diagnostics. */
    lastEmbedError: text("last_embed_error"),
    ...lifecycle_dates,
  },
  (t) => [
    check("documents_source_valid", sql`${t.source} IN (${inList(DOCUMENT_SOURCES)})`),
    uniqueIndex("documents_source_id_idx").on(t.userId, t.source, t.sourceId),
    /**
     * One corpus row per distinct attachment content (ADR-0091 lane: content
     * dedup). The same unchanged file arriving under N different
     * `messageId:attachmentId` source ids extracts and embeds once; later
     * occurrences are recorded as `metadata.references` on the canonical row.
     * Partial by source so identical mail bodies across two emails never
     * collide — only the immutable-bytes attachment door claims
     * content-level identity today.
     *
     * Accepted edges, decided in #877/#878:
     * - Keyed by user, not account: identical content across two linked
     *   accounts folds into one row whose `accountId` names the first
     *   carrier only. Per-carrier provenance rides `metadata.references`
     *   (each entry carries `accountId`).
     * - `content_hash` covers normalized extractor text, not bytes. An
     *   extractor upgrade mints a fresh canonical row for byte-identical
     *   files; dedup decays until a re-index. Deliberately not salted with
     *   an extractor version — salting cannot prevent the duplicate.
     */
    uniqueIndex("documents_attachment_content_hash_idx")
      .on(t.userId, t.source, t.contentHash)
      .where(sql`${t.source} = 'gmail_attachment'`),
    index("documents_user_source_idx").on(t.userId, t.source, t.authoredAt),
    index("documents_thread_idx").on(t.userId, t.source, t.sourceThreadId),
    index("documents_embed_sweep_idx")
      .on(t.ingestedAt.desc())
      .where(sql`${t.embedFailedAt} IS NULL`),
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
      .$type<ChunkMetadata>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("chunks_document_position_idx").on(t.documentId, t.position),
    index("chunks_user_idx").on(t.userId),
  ],
);

/**
 * The shape `@alfred/corpus` writes into `chunks.metadata`. The embed pipeline
 * is the column's only writer, so this type names every key the column can
 * carry; `page` is optional because rows written before a document had page
 * structure carry none. The database layer cannot constrain jsonb contents,
 * so the corpus package still narrows reads through its validity gate
 * (`extractPageFromMetadata`) — this type makes the honest shape visible, not
 * the persisted rows trustworthy on their own.
 */
export interface ChunkMetadata {
  /** The 1-indexed PDF page the extractor proved this chunk sits on. */
  page?: number;
}

export type Document = typeof documents.$inferSelect;
export type DocumentChunk = typeof chunks.$inferSelect;
