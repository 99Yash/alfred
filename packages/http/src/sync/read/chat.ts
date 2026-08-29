import { MAX_ATTACHMENTS_PER_MESSAGE } from "@alfred/contracts";
import {
  chatAttachments,
  chatMessages,
  chatThreads,
  type ChatAttachment,
  type ChatMessage,
  type ChatThread,
} from "@alfred/db/schemas";
import { asc, desc, eq, getTableColumns } from "drizzle-orm";
import { syncEntity } from "./sync-entity";

/** Most-recent chat messages synced per user — bounds the Replicache pull. */
const CHAT_MESSAGE_PULL_LIMIT = 500;

// Chat (streaming-chat plan). Threads + their messages both sync so history
// survives reloads and reaches every device. Ordered for stable client
// rendering; message sync is bounded to the most recent
// CHAT_MESSAGE_PULL_LIMIT rows so a long history doesn't pull the whole table
// on every pull (the client re-sorts ascending).
export const fetchChatThreads = syncEntity("chatthread", {
  query: (tx, userId) =>
    tx
      .select()
      .from(chatThreads)
      .where(eq(chatThreads.userId, userId))
      .orderBy(desc(chatThreads.pinned), desc(chatThreads.lastMessageAt), asc(chatThreads.id)),
  map: (t: ChatThread) => t,
});

export const fetchChatMessages = syncEntity("chatmsg", {
  query: (tx, userId) =>
    tx
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.userId, userId))
      .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
      .limit(CHAT_MESSAGE_PULL_LIMIT),
  map: (m: ChatMessage) => m,
});

// Attachments on user messages (ADR-0065). Bound to the same recent-message
// window as `chatmsg`, expressed as a join so the pull is one query instead
// of a message-id select followed by a 500-element `inArray`. A synced message
// never loses its image metadata. Display metadata only — the bytes load
// through the auth-gated content proxy.
export const fetchChatAttachments = syncEntity("chatatt", {
  query: async (tx, userId) => {
    const recentMessages = tx
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(eq(chatMessages.userId, userId))
      .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
      .limit(CHAT_MESSAGE_PULL_LIMIT)
      .as("recent_messages");
    return tx
      .select(getTableColumns(chatAttachments))
      .from(chatAttachments)
      .innerJoin(recentMessages, eq(chatAttachments.messageId, recentMessages.id))
      .where(eq(chatAttachments.userId, userId))
      .orderBy(desc(chatAttachments.createdAt), desc(chatAttachments.id))
      .limit(CHAT_MESSAGE_PULL_LIMIT * MAX_ATTACHMENTS_PER_MESSAGE);
  },
  map: (a: ChatAttachment) => a,
});
