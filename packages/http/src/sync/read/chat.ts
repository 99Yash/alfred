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
 * THE ONE DEFINITION OF THE VISIBLE MESSAGE SET. Discovery, loading and
 * `chatatt`'s attachment set all read it, so they cannot drift apart.
 *
 * It is a subquery on purpose. It owns the user guard, the order and the cap;
 * both stages join to it and add only their own restriction outside it. The
 * join on the primary key carries the user guard, so no stage repeats it.
 *
 * `CHAT_MESSAGE_PULL_LIMIT` must bound the whole visible set, not the changed
 * rows. Restricting changed ids inside the cap would let those rows pick the
 * membership, and a concurrent commit between the stages could then load a row
 * the cap no longer holds.
 */
const recentMessages = (tx: DbTransaction, userId: string) =>
  tx
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(eq(chatMessages.userId, userId))
    .orderBy(...messageOrder)
    .limit(CHAT_MESSAGE_PULL_LIMIT)
    .as("recent_messages");

/**
 * THE ONE DEFINITION OF THE VISIBLE ATTACHMENT SET. It owns the recent-message
 * join, the attachment user guard, the order and `CHAT_ATTACHMENT_PULL_LIMIT`.
 *
 * Both stages join to it and put the changed-id restriction outside it, so the
 * cap bounds the full visible attachment set. With the restriction applied
 * first, the cap would instead bound the changed attachments, and a concurrent
 * commit between the stages could make the load stage return a set the
 * discovery stage never described.
 */
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

// Attachments on user messages (ADR-0065). Bound to the same recent-message
// window as `chatmsg`, expressed as `recentAttachments` so one subquery owns the
// message window, the user guard, the order and the attachment cap, and both
// stages read the same set. A synced message never loses its image metadata.
// Display metadata only — the bytes load through the auth-gated content proxy.
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
