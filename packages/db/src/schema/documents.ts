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

/** One row per ingested object from any source (ADR-0010). Re-ingesting is a no-op. */
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
    sourceId: text("source_id").notNull(),
    sourceThreadId: text("source_thread_id"),
    /** Matches `integration_credentials.account_id`. */
    accountId: text("account_id"),
    title: text("title"),
    content: text("content").notNull(),
    /** Lets the chunker skip unchanged docs. */
    contentHash: text("content_hash").notNull(),
    raw: jsonb("raw"),
    url: text("url"),
    authoredAt: timestamp("authored_at", { withTimezone: true }),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).defaultNow().notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Embed failure count, for diagnostics. */
    embedAttempts: integer("embed_attempts").notNull().default(0),
    /** Start of the current failure streak. The retry window counts from here. */
    embedFirstFailedAt: timestamp("embed_first_failed_at", { withTimezone: true }),
    /**
     * Set when embedding is abandoned; the sweep then skips the row.
     * To retry, null this AND `embed_first_failed_at`, or the old streak dead-letters it again.
     */
    embedFailedAt: timestamp("embed_failed_at", { withTimezone: true }),
    lastEmbedError: text("last_embed_error"),
    ...lifecycle_dates,
  },
  (t) => [
    check("documents_source_valid", sql`${t.source} IN (${inList(DOCUMENT_SOURCES)})`),
    uniqueIndex("documents_source_id_idx").on(t.userId, t.source, t.sourceId),
    /**
     * One row per distinct attachment text (ADR-0091). Repeats go in `metadata.references`.
     * Keyed by user, not account, so `accountId` names only the first carrier.
     * The hash covers extracted text, so a new extractor version mints new rows.
     */
    uniqueIndex("documents_attachment_content_hash_idx")
      .on(t.userId, t.source, t.contentHash)
      .where(sql`${t.source} = 'gmail_attachment'`),
    index("documents_user_source_idx").on(t.userId, t.source, t.authoredAt),
    index("documents_source_admission_idx").on(t.userId, t.source, t.ingestedAt),
    index("documents_thread_idx").on(t.userId, t.source, t.sourceThreadId),
    index("documents_embed_sweep_idx")
      .on(t.ingestedAt.desc())
      .where(sql`${t.embedFailedAt} IS NULL`),
  ],
);

/** Searchable slice of a document. The HNSW index lives only in migration SQL. */
export const chunks = pgTable(
  "chunks",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("chk")),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
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

/** What `@alfred/corpus` writes. Readers still validate it (`extractPageFromMetadata`). */
export interface ChunkMetadata {
  /** 1-indexed PDF page. Absent on older rows. */
  page?: number;
}

export type Document = typeof documents.$inferSelect;

export type DocumentChunk = typeof chunks.$inferSelect;
