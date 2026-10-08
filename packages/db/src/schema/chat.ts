import type {
  ChatAttachmentStatus,
  ChatConnectNudge,
  ChatErrorKind,
  ChatMessageUsage,
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
} from "drizzle-orm/pg-core";

import { createId, lifecycle_dates } from "../helpers";
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
    /** Drives the "Thought for Ns" label on reload. */
    reasoningMs: integer("reasoning_ms"),
    status: text("status").notNull().default("complete").$type<ChatMessageStatus>(),
    /** Set on a failed turn. The raw provider error is only logged, never stored. */
    errorKind: text("error_kind").$type<ChatErrorKind>(),
    toolCalls: jsonb("tool_calls").$type<ChatMessageToolCall[]>(),
    /** Interleaved with `toolCalls` by `segmentIndex` on reload. */
    narration: jsonb("narration").$type<ChatMessageNarration[]>(),
    /** Summed from the run's `api_call_log` rows at finalize. */
    usage: jsonb("usage").$type<ChatMessageUsage>(),
    /** Set on both the user turn and its reply. */
    runId: text("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [
    index("chat_messages_user_idx").on(t.userId),
    index("chat_messages_thread_created_idx").on(t.threadId, t.createdAt),
    index("chat_messages_run_idx").on(t.runId),
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
    index("chat_thread_context_user_idx").on(t.userId),
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
    index("chat_attachments_user_idx").on(t.userId),
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

export type ChatThreadContext = typeof chatThreadContext.$inferSelect;

export type NewChatThreadContext = typeof chatThreadContext.$inferInsert;

export type ChatAttachment = typeof chatAttachments.$inferSelect;

export type NewChatAttachment = typeof chatAttachments.$inferInsert;

export type ChatAttachmentRepresentation = typeof chatAttachmentRepresentations.$inferSelect;

export type NewChatAttachmentRepresentation = typeof chatAttachmentRepresentations.$inferInsert;
