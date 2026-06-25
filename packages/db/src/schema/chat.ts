import type { ChatAttachmentStatus, ChatErrorKind } from "@alfred/contracts";
import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { createId, lifecycle_dates } from "../helpers";
import { agentRuns } from "./agent";
import { user } from "./auth";

/**
 * Interactive chat (streaming-chat plan). A `chat_threads` row is one
 * conversation; `chat_messages` are its turns. Both sync to the web via
 * Replicache so threads/history are durable and multi-device.
 *
 * The agent's reply streams live over the SSE event bus (`chat.delta` /
 * `chat.tool`); the *durable* assistant message is written here by the chat
 * worker on completion (then a Replicache poke syncs it). So a `chat_messages`
 * row is always a finished turn — partial streamed text is never persisted.
 */
export type ChatMessageRole = "user" | "assistant";
export type ChatMessageStatus = "complete" | "failed";

/**
 * A tool call captured on a finished assistant turn, so a reload re-renders
 * the tool cards the user saw stream in. Mirrors the live `chat.tool` event
 * payload (minus the routing ids).
 */
export interface ChatMessageToolCall {
  toolCallId: string;
  toolName: string;
  status: "succeeded" | "failed";
  argsPreview?: string;
  resultPreview?: string;
  /**
   * ADR-0070: the dispatch-boundary sanitizer stripped non-text bytes from this
   * result before storage. Persisted so a reload re-renders the "trimmed" flag
   * the user saw live, rather than showing a scrubbed result as pristine.
   */
  sanitized?: boolean;
  /**
   * The narration segment this call follows, so a reload can interleave it
   * with the model's narration in the activity trail. Absent on rows written
   * before interleaved narration shipped (read back as 0).
   */
  segmentIndex?: number;
}

/**
 * One closed narration segment captured on a finished assistant turn: the
 * brief line the model wrote before a tool step. `index` matches the
 * `segmentIndex` carried on the tool calls so a reload re-interleaves them.
 * The final (answer) segment is never stored here — it lives in `content`.
 */
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
    /** Short title; null until derived from the first turn. */
    title: text("title"),
    /** Sort key for the thread list — bumped on every new message. */
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    /** User-pinned threads float to a "Pinned" group above the date buckets. */
    pinned: boolean("pinned").notNull().default(false),
    /** Replicache row-version. Bumped on title / lastMessageAt / pinned changes. */
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
    /** 'user' (client mutator) | 'assistant' (worker-written on completion). */
    role: text("role").notNull().$type<ChatMessageRole>(),
    /** Final text content of the turn. */
    content: text("content").notNull().default(""),
    /** The model's thinking for this turn (assistant only); null when the model emitted none. */
    reasoning: text("reasoning"),
    /** Wall-clock the model spent thinking, in ms — drives the "Thought for Ns" label on reload. */
    reasoningMs: integer("reasoning_ms"),
    /** 'complete' once the turn finished, 'failed' on a terminal turn error. */
    status: text("status").notNull().default("complete").$type<ChatMessageStatus>(),
    /**
     * On a `status:"failed"` turn, the user-meaningful failure kind the client
     * pattern-matches to a tailored message + recovery affordance. Null on
     * `complete` rows (and on legacy failed rows written before this column).
     * The raw provider error is logged server-side only, never persisted here.
     */
    errorKind: text("error_kind").$type<ChatErrorKind>(),
    /** Tool cards to re-render on reload (assistant turns only). */
    toolCalls: jsonb("tool_calls").$type<ChatMessageToolCall[]>(),
    /**
     * Closed narration segments (the brief lines the model wrote before each
     * tool step), interleaved with `toolCalls` by `segmentIndex` on reload.
     * Null when the turn produced none.
     */
    narration: jsonb("narration").$type<ChatMessageNarration[]>(),
    /** The agent run servicing this turn (set on both the user turn and its reply). */
    runId: text("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    /** Replicache row-version. Bumped on any content/status change. */
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [
    index("chat_messages_user_idx").on(t.userId),
    index("chat_messages_thread_created_idx").on(t.threadId, t.createdAt),
  ],
);

/**
 * A file the user attached to a chat message (ADR-0065). The raw bytes live in
 * an object bucket under `chat/{userId}/{threadId}/{messageId}/{file}`; only the
 * `storageKey` is recorded here. The model never sees the raw media — at turn
 * time we fold in the *degraded artifact* (`degradedText` + `degradedImageKeys`)
 * once `status` is `ready`. A separate table (not a jsonb column on the message)
 * so the async degrade can flip status / write the artifact without rewriting
 * the message row. Deleting the message — or the thread, or the user — cascades
 * the rows; the bucket objects are reaped by a prefix-delete cleanup job (the FK
 * cascade can't reach object storage).
 * `status` is the canonical {@link ChatAttachmentStatus} from `@alfred/contracts`.
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
    /** Object-store key: `chat/{userId}/{threadId}/{messageId}/{file}`. */
    storageKey: text("storage_key").notNull(),
    /** Original filename, for the composer chip + download affordance. */
    name: text("name").notNull(),
    /** Declared MIME type; the ingest policy is keyed off it. */
    mime: text("mime").notNull(),
    /** Byte size as reported by the client (capped per the ingest policy). */
    size: integer("size").notNull(),
    /** Stable order within the message; model + UI preserve this order. */
    position: integer("position").notNull().default(0),
    /** 'pending' (uploading/degrading) | 'ready' (artifact written) | 'failed'. */
    status: text("status").notNull().default("pending").$type<ChatAttachmentStatus>(),
    /** Degraded text artifact (transcript / extracted text); null for images. */
    degradedText: text("degraded_text"),
    /**
     * Object-store keys of degraded keyframe images (video) — folded into the
     * transcript as image parts. Empty for non-video; the upload's own bytes (an
     * image) are referenced by `storageKey`, not here.
     */
    degradedImageKeys: jsonb("degraded_image_keys")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Set when `status` is 'failed' — a short, user-facing reason. */
    failureReason: text("failure_reason"),
    /** Replicache row-version. Bumped on status flips (e.g. pending→ready). */
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [
    // `(message_id, position)` also serves message_id-prefix lookups, so a
    // standalone message_id index would be redundant.
    index("chat_attachments_message_position_idx").on(t.messageId, t.position),
    index("chat_attachments_user_idx").on(t.userId),
  ],
);

export type ChatThread = typeof chatThreads.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type ChatAttachment = typeof chatAttachments.$inferSelect;
