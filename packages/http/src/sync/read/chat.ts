import { MAX_ATTACHMENTS_PER_MESSAGE } from "@alfred/contracts";
import type { DbTransaction } from "@alfred/db";
import {
  chatAttachments,
  chatMessages,
  chatThreads,
  type ChatAttachment,
  type ChatMessage,
  type ChatThread,
} from "@alfred/db/schemas";
import { SYNC_MODEL } from "@alfred/sync";
import { and, asc, desc, eq, getTableColumns, inArray } from "drizzle-orm";
import { syncEntity } from "./sync-entity";

const CHAT_MESSAGE_PULL_LIMIT = 500;

const CHAT_ATTACHMENT_PULL_LIMIT = CHAT_MESSAGE_PULL_LIMIT * MAX_ATTACHMENTS_PER_MESSAGE;

const messageOrder = [desc(chatMessages.createdAt), desc(chatMessages.id)];

const attachmentOrder = [desc(chatAttachments.createdAt), desc(chatAttachments.id)];

/**
 * The visible message set, shared by both stages and by `chatatt`.
 * The cap must bound the whole set, not the changed rows, or a concurrent
 * commit could load a row the cap no longer holds.
 */
const recentMessages = (tx: DbTransaction, userId: string) =>
  tx
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(eq(chatMessages.userId, userId))
    .orderBy(...messageOrder)
    .limit(CHAT_MESSAGE_PULL_LIMIT)
    .as("recent_messages");

/** The visible attachment set, on the same message window. Same rule as `recentMessages`. */
const recentAttachments = (tx: DbTransaction, userId: string) => {
  const messages = recentMessages(tx, userId);

  return tx
    .select({ id: chatAttachments.id })
    .from(chatAttachments)
    .innerJoin(messages, eq(chatAttachments.messageId, messages.id))
    .where(eq(chatAttachments.userId, userId))
    .orderBy(...attachmentOrder)
    .limit(CHAT_ATTACHMENT_PULL_LIMIT)
    .as("recent_attachments");
};

const ownedThread = (userId: string) => eq(chatThreads.userId, userId);

export const fetchChatThreads = syncEntity(SYNC_MODEL.chatthread, {
  versionQuery: (tx, userId) =>
    tx
      .select({ id: chatThreads.id, rowVersion: chatThreads.rowVersion })
      .from(chatThreads)
      .where(ownedThread(userId))
      .orderBy(desc(chatThreads.pinned), desc(chatThreads.lastMessageAt), asc(chatThreads.id)),
  loadQuery: (tx, userId, changed) =>
    tx
      .select()
      .from(chatThreads)
      .where(
        and(
          ownedThread(userId),
          inArray(
            chatThreads.id,
            changed.map((v) => v.id),
          ),
        ),
      )
      .orderBy(desc(chatThreads.pinned), desc(chatThreads.lastMessageAt), asc(chatThreads.id)),
  map: (t: ChatThread) => t,
});

export const fetchChatMessages = syncEntity(SYNC_MODEL.chatmsg, {
  versionQuery: (tx, userId) => {
    const visible = recentMessages(tx, userId);

    return tx
      .select({ id: chatMessages.id, rowVersion: chatMessages.rowVersion })
      .from(chatMessages)
      .innerJoin(visible, eq(chatMessages.id, visible.id))
      .orderBy(...messageOrder);
  },
  loadQuery: (tx, userId, changed) => {
    const visible = recentMessages(tx, userId);

    return tx
      .select(getTableColumns(chatMessages))
      .from(chatMessages)
      .innerJoin(visible, eq(chatMessages.id, visible.id))
      .where(
        inArray(
          chatMessages.id,
          changed.map((v) => v.id),
        ),
      )
      .orderBy(...messageOrder);
  },
  map: (m: ChatMessage) => m,
});

// Attachment metadata only (ADR-0065). The bytes load through the content proxy.
export const fetchChatAttachments = syncEntity(SYNC_MODEL.chatatt, {
  versionQuery: (tx, userId) => {
    const visible = recentAttachments(tx, userId);

    return tx
      .select({ id: chatAttachments.id, rowVersion: chatAttachments.rowVersion })
      .from(chatAttachments)
      .innerJoin(visible, eq(chatAttachments.id, visible.id))
      .orderBy(...attachmentOrder);
  },
  loadQuery: (tx, userId, changed) => {
    const visible = recentAttachments(tx, userId);

    return tx
      .select(getTableColumns(chatAttachments))
      .from(chatAttachments)
      .innerJoin(visible, eq(chatAttachments.id, visible.id))
      .where(
        inArray(
          chatAttachments.id,
          changed.map((v) => v.id),
        ),
      )
      .orderBy(...attachmentOrder);
  },
  map: (a: ChatAttachment) => a,
});
