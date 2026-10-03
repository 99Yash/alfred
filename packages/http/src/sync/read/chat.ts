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

/** Most-recent chat messages synced per user — bounds the Replicache pull. */
const CHAT_MESSAGE_PULL_LIMIT = 500;

/** Attachments synced per user, on the same recent-message window as `chatmsg`. */
const CHAT_ATTACHMENT_PULL_LIMIT = CHAT_MESSAGE_PULL_LIMIT * MAX_ATTACHMENTS_PER_MESSAGE;

const messageOrder = [desc(chatMessages.createdAt), desc(chatMessages.id)];

const attachmentOrder = [desc(chatAttachments.createdAt), desc(chatAttachments.id)];

/**
 * THE ONE DEFINITION OF THE VISIBLE MESSAGE SET, shared by `chatmsg` and by
 * `chatatt`'s attachment join.
 *
 * It is a subquery on purpose. Every per-pull restriction is applied *outside*
 * it, so `CHAT_MESSAGE_PULL_LIMIT` still bounds the whole visible set instead
 * of the changed rows: restricting changed ids inside the limit would let 500
 * changed messages push visible unchanged messages out of the patch, and would
 * hand `chatatt` a different membership than its own version query saw.
 */
const recentMessages = (tx: DbTransaction, userId: string) =>
  tx
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(eq(chatMessages.userId, userId))
    .orderBy(...messageOrder)
    .limit(CHAT_MESSAGE_PULL_LIMIT)
    .as("recent_messages");

const ownedThread = (userId: string) => eq(chatThreads.userId, userId);

// Chat (streaming-chat plan). Threads + their messages both sync so history
// survives reloads and reaches every device. Ordered for stable client
// rendering; message sync is bounded to the most recent
// CHAT_MESSAGE_PULL_LIMIT rows so a long history doesn't pull the whole table
// on every pull (the client re-sorts ascending).
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
  versionQuery: (tx, userId) =>
    tx
      .select({ id: chatMessages.id, rowVersion: chatMessages.rowVersion })
      .from(chatMessages)
      .where(eq(chatMessages.userId, userId))
      .orderBy(...messageOrder)
      .limit(CHAT_MESSAGE_PULL_LIMIT),
  loadQuery: (tx, userId, changed) => {
    const visible = recentMessages(tx, userId);

    return tx
      .select(getTableColumns(chatMessages))
      .from(chatMessages)
      .innerJoin(visible, eq(chatMessages.id, visible.id))
      .where(
        and(
          eq(chatMessages.userId, userId),
          inArray(
            chatMessages.id,
            changed.map((v) => v.id),
          ),
        ),
      )
      .orderBy(...messageOrder);
  },
  map: (m: ChatMessage) => m,
});

// Attachments on user messages (ADR-0065). Bound to the same recent-message
// window as `chatmsg`, expressed as a join so the pull is one query instead
// of a message-id select followed by a 500-element `inArray`. A synced message
// never loses its image metadata. Display metadata only — the bytes load
// through the auth-gated content proxy.
export const fetchChatAttachments = syncEntity(SYNC_MODEL.chatatt, {
  versionQuery: (tx, userId) => {
    const visible = recentMessages(tx, userId);

    return tx
      .select({ id: chatAttachments.id, rowVersion: chatAttachments.rowVersion })
      .from(chatAttachments)
      .innerJoin(visible, eq(chatAttachments.messageId, visible.id))
      .where(eq(chatAttachments.userId, userId))
      .orderBy(...attachmentOrder)
      .limit(CHAT_ATTACHMENT_PULL_LIMIT);
  },
  loadQuery: (tx, userId, changed) => {
    const visible = recentMessages(tx, userId);

    return tx
      .select(getTableColumns(chatAttachments))
      .from(chatAttachments)
      .innerJoin(visible, eq(chatAttachments.messageId, visible.id))
      .where(
        and(
          eq(chatAttachments.userId, userId),
          inArray(
            chatAttachments.id,
            changed.map((v) => v.id),
          ),
        ),
      )
      .orderBy(...attachmentOrder)
      .limit(CHAT_ATTACHMENT_PULL_LIMIT);
  },
  map: (a: ChatAttachment) => a,
});
