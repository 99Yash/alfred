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
    /** Tool cards to re-render on reload (assistant turns only). */
    toolCalls: jsonb("tool_calls").$type<ChatMessageToolCall[]>(),
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
