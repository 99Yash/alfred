import type {
  ApprovalReason,
  ChatAttachmentStatus,
  ChatConnectNudge,
  ChatErrorKind,
  ChatMessageUsage,
  ScriptSources,
} from "@alfred/contracts";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { createId, lifecycle_dates, vectorColumn } from "../helpers";
import { agentRuns } from "./agent";
import { user } from "./auth";

/** A `chat_messages` row is always a finished turn. Partial streamed text is never stored. */
export type ChatMessageRole = "user" | "assistant";

export type ChatMessageStatus = "complete" | "failed";

/** A tool card from a finished turn, so a reload shows what streamed live. */
export interface ChatMessageToolCall {
  toolCallId: string;
  toolName: string;
  status: "succeeded" | "failed";
  argsPreview?: string | undefined;
  resultPreview?: string | undefined;
  /** `preview()` pruned the result. A pruned preview still parses, so a reader cannot tell otherwise. */
  resultTruncated?: boolean | undefined;
  /** The sanitizer stripped non-text bytes from the result (ADR-0070). */
  sanitized?: boolean | undefined;
  /** The narration segment this call follows. Absent reads as 0. */
  segmentIndex?: number | undefined;
  /**
   * Set only when a connection-health check bounced the call, so a reload offers the repair again.
   * A newer build can store a slug this enum lacks. Only `syncedChatToolCallSchema` checks it.
   */
  connectNudge?: ChatConnectNudge | undefined;
  /**
   * Set only after a card: why it asked (ADR-0130 amendment (c)). The web derives the settings
   * that remove such a card from current policy. The turn log (`toolCallLogSchema`) and
   * `syncedChatToolCallSchema` parse it.
   */
  approvalReason?: ApprovalReason | undefined;
  /**
   * The web pages of a `system.code_run` script (ADR-0124). The preview prunes them, so a reload
   * reads them here. The turn log (`toolCallLogSchema`) and `syncedChatToolCallSchema` parse it.
   */
  scriptSources?: ScriptSources | undefined;
}

/** The line the model wrote before a tool step. The final answer is in `content`, not here. */
export interface ChatMessageNarration {
  index: number;
  text: string;
}

export const chatThreads = pgTable(
  "chat_threads",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("thread")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Null until derived from the first turn. */
    title: text("title"),
    /** Thread list sort key. */
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    pinned: boolean("pinned").notNull().default(false),
    /**
     * Chat full autonomy: this thread's runs and their sub-agents skip every approval card, the
     * high-tier floor included (ADR-0069 amendment). The gate reads it live, so a change mid-turn
     * applies to the next call.
     */
    fullAutonomy: boolean("full_autonomy").notNull().default(false),
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [index("chat_threads_user_last_idx").on(t.userId, t.lastMessageAt)],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("msg")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    role: text("role").notNull().$type<ChatMessageRole>(),
    content: text("content").notNull().default(""),
    reasoning: text("reasoning"),
    /**
     * Drives the "Thought for Ns" label on reload. Claim to the first reply text or approval
     * park. Rows before 2026-10-22 hold the sum of the reasoning spans only.
     */
    reasoningMs: integer("reasoning_ms"),
    status: text("status").notNull().default("complete").$type<ChatMessageStatus>(),
    /** Set on a failed turn. The raw provider error is only logged, never stored. */
    errorKind: text("error_kind").$type<ChatErrorKind>(),
    toolCalls: jsonb("tool_calls").$type<ChatMessageToolCall[]>(),
    /** Interleaved with `toolCalls` by `segmentIndex` on reload. */
    narration: jsonb("narration").$type<ChatMessageNarration[]>(),
    /** Summed from the run's `api_call_log` rows at finalize. */
    usage: jsonb("usage").$type<ChatMessageUsage>(),
    /**
     * Next-prompt suggestions on a completed reply, written after the reply closes (ADR-0112).
     * Null until the cheap call lands, and when it fails or returns none.
     */
    followUps: text("follow_ups").array(),
    /** Set on the reply. A user row carries none: its run names it in `agent_runs.metadata`. */
    runId: text("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [
    // The Replicache pull window (`recentMessages`) filters user_id and orders
    // created_at DESC, id DESC; plain columns so a backward scan matches the
    // query's NULLS FIRST order exactly (a .desc() index renders NULLS LAST).
    index("chat_messages_user_created_idx").on(t.userId, t.createdAt, t.id),
    index("chat_messages_thread_created_idx").on(t.threadId, t.createdAt),
    index("chat_messages_run_idx").on(t.runId),
  ],
);

/**
 * The turn context of one user message, saved once when the turn is admitted (ADR-0130 decision 7,
 * amendment (g)): the time note text, or none, and the selected artifact version. It holds values,
 * not the rendered prompt text, and never an artifact body (`artifact_versions` holds the bodies).
 * Server-only, so it is not a `chat_messages` column, which Replicache syncs whole.
 */
export const chatTurnContexts = pgTable("chat_turn_contexts", {
  messageId: text("message_id")
    .primaryKey()
    .references(() => chatMessages.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  /** Untyped: `chatTurnContextSchema` in `@alfred/assistant` owns the shape, and each read parses. */
  context: jsonb("context").notNull(),
  ...lifecycle_dates,
});

/**
 * The search index of past chats (journal.md section 3): one row for each exchange, the user
 * message and its reply. Derived from `chat_messages`, so a delete of the rows rebuilds it. Each
 * message id cascades, so a deleted thread or message leaves the index in the same statement.
 * Server-only, not synced. The HNSW index lives only in migration SQL, as for `chunks`.
 */
export const chatExchanges = pgTable(
  "chat_exchanges",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("cex")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    userMessageId: text("user_message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    /** The reply of the run that the user message carries. A retry moves the row to the new reply. */
    replyMessageId: text("reply_message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    /** The text that is embedded: the user's words, then the reply. */
    content: text("content").notNull(),
    /** sha256 of `content`. A changed exchange gets a new hash and a new embedding. */
    contentHash: text("content_hash").notNull(),
    embedding: vectorColumn("embedding", 1024),
    // Embed retry columns, same as `memory_chunks`. See `buildEmbedFailureSet`.
    embedAttempts: integer("embed_attempts").notNull().default(0),
    embedFirstFailedAt: timestamp("embed_first_failed_at", { withTimezone: true }),
    /** Dead-letter mark; the sweep skips the row. To retry in place, null this and `embedFirstFailedAt`. */
    embedFailedAt: timestamp("embed_failed_at", { withTimezone: true }),
    lastEmbedError: text("last_embed_error"),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("chat_exchanges_user_message_idx").on(t.userMessageId),
    index("chat_exchanges_reply_message_idx").on(t.replyMessageId),
    index("chat_exchanges_user_thread_idx").on(t.userId, t.threadId),
    index("chat_exchanges_embed_sweep_idx")
      .on(t.id)
      .where(sql`${t.embedding} IS NULL AND ${t.embedFailedAt} IS NULL`),
  ],
);

/** Server-only compaction state for a thread. Not synced to Replicache. */
export const chatThreadContext = pgTable(
  "chat_thread_context",
  {
    threadId: text("thread_id")
      .primaryKey()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    summary: jsonb("summary"),
    summaryWatermarkCreatedAt: timestamp("summary_watermark_created_at", { withTimezone: true }),
    summaryWatermarkMessageId: text("summary_watermark_message_id"),
    estimatedReplayTokens: integer("estimated_replay_tokens").notNull().default(0),
    replayEstimateWatermarkCreatedAt: timestamp("replay_estimate_watermark_created_at", {
      withTimezone: true,
    }),
    replayEstimateWatermarkMessageId: text("replay_estimate_watermark_message_id"),
    compactionRequestedAt: timestamp("compaction_requested_at", { withTimezone: true }),
    compactionCompletedAt: timestamp("compaction_completed_at", { withTimezone: true }),
    compactionFailedAt: timestamp("compaction_failed_at", { withTimezone: true }),
    compactionFailureCategory: text("compaction_failure_category"),
    compactionFailureMessage: text("compaction_failure_message"),
    /** Compare-and-swap revision. Only a winning summary write bumps it. */
    compactionGeneration: integer("compaction_generation").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [
    // No user_id index: thread_id is the primary key and every lookup uses it.
    check(
      "chat_thread_context_watermark_pair_chk",
      sql`(${t.summaryWatermarkCreatedAt} IS NULL) = (${t.summaryWatermarkMessageId} IS NULL)`,
    ),
    check("chat_thread_context_estimated_tokens_chk", sql`${t.estimatedReplayTokens} >= 0`),
    check(
      "chat_thread_context_replay_estimate_watermark_pair_chk",
      sql`(${t.replayEstimateWatermarkCreatedAt} IS NULL) = (${t.replayEstimateWatermarkMessageId} IS NULL)`,
    ),
    check("chat_thread_context_generation_chk", sql`${t.compactionGeneration} >= 0`),
  ],
);

/**
 * A file attached to a chat message (ADR-0065). The model sees only the degraded
 * artifact, never the raw media. A cascade delete does not reach the bucket;
 * a prefix delete cleans up the objects.
 */
export const chatAttachments = pgTable(
  "chat_attachments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("att")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    /** `chat/{userId}/{threadId}/{messageId}/{file}`. */
    storageKey: text("storage_key").notNull(),
    name: text("name").notNull(),
    /** Declared MIME type. The ingest policy keys off it. */
    mime: text("mime").notNull(),
    /** Client-reported byte size. */
    size: integer("size").notNull(),
    position: integer("position").notNull().default(0),
    status: text("status").notNull().default("pending").$type<ChatAttachmentStatus>(),
    /** Transcript or extracted text. Null for images. */
    degradedText: text("degraded_text"),
    /** Video keyframes only. An uploaded image lives at `storageKey`. */
    degradedImageKeys: jsonb("degraded_image_keys")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** User-facing reason when `status` is `failed`. */
    failureReason: text("failure_reason"),
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [
    // Also serves `message_id` lookups, so no separate index.
    index("chat_attachments_message_position_idx").on(t.messageId, t.position),
    // Same pull-window shape as `chat_messages_user_created_idx` (backward scan).
    index("chat_attachments_user_created_idx").on(t.userId, t.createdAt, t.id),
  ],
);

/** One enrichment per attachment version, reused by compaction and history. */
export const chatAttachmentRepresentations = pgTable(
  "chat_attachment_representations",
  {
    attachmentId: text("attachment_id")
      .notNull()
      .references(() => chatAttachments.id, { onDelete: "cascade" }),
    representationVersion: integer("representation_version").notNull(),
    status: text("status").notNull().$type<"pending" | "ready" | "failed">(),
    representation: jsonb("representation"),
    provider: text("provider"),
    model: text("model"),
    estimatedCostMicrousd: integer("estimated_cost_microusd"),
    failureCategory: text("failure_category"),
    ...lifecycle_dates,
  },
  (t) => [
    primaryKey({ columns: [t.attachmentId, t.representationVersion] }),
    check("chat_attachment_representations_version_chk", sql`${t.representationVersion} > 0`),
    check(
      "chat_attachment_representations_cost_chk",
      sql`${t.estimatedCostMicrousd} IS NULL OR ${t.estimatedCostMicrousd} >= 0`,
    ),
  ],
);

export type ChatThread = typeof chatThreads.$inferSelect;

export type ChatMessage = typeof chatMessages.$inferSelect;

export type ChatExchange = typeof chatExchanges.$inferSelect;

export type ChatThreadContext = typeof chatThreadContext.$inferSelect;

export type NewChatThreadContext = typeof chatThreadContext.$inferInsert;

export type ChatAttachment = typeof chatAttachments.$inferSelect;

export type NewChatAttachment = typeof chatAttachments.$inferInsert;

export type ChatAttachmentRepresentation = typeof chatAttachmentRepresentations.$inferSelect;

export type NewChatAttachmentRepresentation = typeof chatAttachmentRepresentations.$inferInsert;
