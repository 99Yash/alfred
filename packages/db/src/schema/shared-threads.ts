import type { SharedThreadArtifact, SharedThreadMessage } from "@alfred/contracts";
import { index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { createId, lifecycle_dates } from "../helpers";
import { user } from "./auth";
import { chatThreads } from "./chat";

/**
 * A frozen public snapshot of one chat thread (ADR-0102). Later turns do not change it.
 * Rows hold only redacted shapes, made at write time (`toSharedMessage`), so raw tool
 * output never reaches this table. Do not widen the columns to the synced types.
 * Anyone with `url_slug` can read it. Revoke is a hard delete.
 */
export const sharedThreads = pgTable(
  "shared_threads",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("share")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Cascade, so deleting the thread unpublishes it. */
    sourceThreadId: text("source_thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    /** Random suffix, so the title alone cannot guess it (ADR-0102 D2). */
    urlSlug: text("url_slug").notNull(),
    title: text("title").notNull(),
    messages: jsonb("messages").$type<SharedThreadMessage[]>().notNull(),
    artifacts: jsonb("artifacts").$type<SharedThreadArtifact[]>().notNull(),
    /** Hash of title, messages, and artifacts. See `snapshotDigest`. */
    snapshotDigest: text("snapshot_digest").notNull(),
    /** Stored so the share list does not load the body. */
    messageCount: integer("message_count").notNull(),
    artifactCount: integer("artifact_count").notNull(),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("shared_threads_url_slug_idx").on(t.urlSlug),
    // Makes Share idempotent, even under concurrent clicks. A changed thread gets a new share.
    uniqueIndex("shared_threads_thread_digest_idx").on(t.sourceThreadId, t.snapshotDigest),
    index("shared_threads_source_thread_idx").on(t.sourceThreadId, t.createdAt),
    index("shared_threads_user_idx").on(t.userId),
  ],
);

export type SharedThread = typeof sharedThreads.$inferSelect;

export type NewSharedThread = typeof sharedThreads.$inferInsert;
