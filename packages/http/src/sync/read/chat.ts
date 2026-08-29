import { MAX_ATTACHMENTS_PER_MESSAGE } from "@alfred/contracts";
import {
  chatAttachments,
  chatMessages,
  chatThreads,
  type ChatAttachment,
  type ChatMessage,
  type ChatThread,
} from "@alfred/db/schemas";
import {
  syncedChatAttachmentSchema,
  syncedChatMessageSchema,
  syncedChatThreadSchema,
  type SyncedChatAttachment,
  type SyncedChatMessage,
  type SyncedChatThread,
} from "@alfred/sync";
import { asc, desc, eq, getTableColumns } from "drizzle-orm";
import { defineFetcher } from "./define-fetcher";
import { defineSerializer } from "./define-serializer";

/** Most-recent chat messages synced per user — bounds the Replicache pull. */
const CHAT_MESSAGE_PULL_LIMIT = 500;

const serializeChatThread = defineSerializer<ChatThread, SyncedChatThread>(syncedChatThreadSchema);

const serializeChatAttachment = defineSerializer<ChatAttachment, SyncedChatAttachment>(
  syncedChatAttachmentSchema,
);

/**
 * Owner-only serializer: this is synced to the authenticated thread owner via
 * Replicache and carries the raw `reasoning` (thinking), `narration`, and
 * tool-call previews — which can echo internal artifact-engine details and
 * stored user-memory. Do NOT reuse it (or `SyncedChatMessage`) for a shared /
 * public thread reader if the "Share thread" affordance is ever wired up; a
 * shared read path needs its own serializer that projects only `role` +
 * `content` (and scrubbed tool calls) and drops `reasoning`/`narration`.
 */
const serializeChatMessage = defineSerializer<ChatMessage, SyncedChatMessage>(
  syncedChatMessageSchema,
);

// Chat (streaming-chat plan). Threads + their messages both sync so history
// survives reloads and reaches every device. Ordered for stable client
// rendering; message sync is bounded to the most recent
// CHAT_MESSAGE_PULL_LIMIT rows so a long history doesn't pull the whole table
// on every pull (the client re-sorts ascending).
export const fetchChatThreads = defineFetcher<ChatThread>({
  slug: "CHAT_THREAD",
  query: (tx, userId) =>
    tx
      .select()
      .from(chatThreads)
      .where(eq(chatThreads.userId, userId))
      .orderBy(desc(chatThreads.pinned), desc(chatThreads.lastMessageAt), asc(chatThreads.id)),
  idOf: (t) => t.id,
  versionOf: (t) => t.rowVersion,
  serialize: serializeChatThread,
});

export const fetchChatMessages = defineFetcher<ChatMessage>({
  slug: "CHAT_MESSAGE",
  query: (tx, userId) =>
    tx
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.userId, userId))
      .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
      .limit(CHAT_MESSAGE_PULL_LIMIT),
  idOf: (m) => m.id,
  versionOf: (m) => m.rowVersion,
  serialize: serializeChatMessage,
});

// Attachments on user messages (ADR-0065). Bound to the same recent-message
// window as CHAT_MESSAGE, expressed as a join so the pull is one query instead
// of a message-id select followed by a 500-element `inArray`. A synced message
// never loses its image metadata. Display metadata only — the bytes load
// through the auth-gated content proxy.
export const fetchChatAttachments = defineFetcher<ChatAttachment>({
  slug: "CHAT_ATTACHMENT",
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
  idOf: (a) => a.id,
  versionOf: (a) => a.rowVersion,
  serialize: serializeChatAttachment,
});
