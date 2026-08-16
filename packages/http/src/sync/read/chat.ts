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
import { toEntityRow, type EntityFetcher } from "./entity-row";
import { toIso, toRequiredIso } from "./iso-date";

/** Most-recent chat messages synced per user — bounds the Replicache pull. */
const CHAT_MESSAGE_PULL_LIMIT = 500;

// Chat (streaming-chat plan). Threads + their messages both sync so history
// survives reloads and reaches every device. Ordered for stable client
// rendering; message sync is bounded to the most recent
// CHAT_MESSAGE_PULL_LIMIT rows so a long history doesn't pull the whole table
// on every pull (the client re-sorts ascending).
export const fetchChatThreads: EntityFetcher = async (tx, userId) => {
  const rows = await tx
    .select()
    .from(chatThreads)
    .where(eq(chatThreads.userId, userId))
    .orderBy(desc(chatThreads.pinned), desc(chatThreads.lastMessageAt), asc(chatThreads.id));
  return rows.flatMap((t: ChatThread) =>
    toEntityRow({
      slug: "CHAT_THREAD",
      id: t.id,
      rowVersion: t.rowVersion,
      serialize: () => serializeChatThread(t),
    }),
  );
};

export const fetchChatMessages: EntityFetcher = async (tx, userId) => {
  const rows = await tx
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.userId, userId))
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(CHAT_MESSAGE_PULL_LIMIT);
  return rows.flatMap((m: ChatMessage) =>
    toEntityRow({
      slug: "CHAT_MESSAGE",
      id: m.id,
      rowVersion: m.rowVersion,
      serialize: () => serializeChatMessage(m),
    }),
  );
};

// Attachments on user messages (ADR-0065). Bound to the same recent-message
// window as CHAT_MESSAGE, expressed as a join so the pull is one query instead
// of a message-id select followed by a 500-element `inArray`. A synced message
// never loses its image metadata. Display metadata only — the bytes load
// through the auth-gated content proxy.
export const fetchChatAttachments: EntityFetcher = async (tx, userId) => {
  const recentMessages = tx
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(eq(chatMessages.userId, userId))
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(CHAT_MESSAGE_PULL_LIMIT)
    .as("recent_messages");
  const rows = await tx
    .select(getTableColumns(chatAttachments))
    .from(chatAttachments)
    .innerJoin(recentMessages, eq(chatAttachments.messageId, recentMessages.id))
    .where(eq(chatAttachments.userId, userId))
    .orderBy(desc(chatAttachments.createdAt), desc(chatAttachments.id))
    .limit(CHAT_MESSAGE_PULL_LIMIT * MAX_ATTACHMENTS_PER_MESSAGE);
  return rows.flatMap((a: ChatAttachment) =>
    toEntityRow({
      slug: "CHAT_ATTACHMENT",
      id: a.id,
      rowVersion: a.rowVersion,
      serialize: () => serializeChatAttachment(a),
    }),
  );
};

function serializeChatThread(t: ChatThread): SyncedChatThread {
  return syncedChatThreadSchema.parse({
    id: t.id,
    userId: t.userId,
    title: t.title,
    lastMessageAt: toIso(t.lastMessageAt),
    pinned: t.pinned,
    rowVersion: t.rowVersion,
    createdAt: toRequiredIso(t.createdAt, "chatThreads.createdAt"),
    updatedAt: toIso(t.updatedAt),
  });
}

function serializeChatAttachment(a: ChatAttachment): SyncedChatAttachment {
  return syncedChatAttachmentSchema.parse({
    id: a.id,
    messageId: a.messageId,
    name: a.name,
    mime: a.mime,
    size: a.size,
    position: a.position,
    status: a.status,
    rowVersion: a.rowVersion,
    createdAt: toRequiredIso(a.createdAt, "chatAttachments.createdAt"),
    updatedAt: toIso(a.updatedAt),
  });
}

/**
 * Owner-only serializer: this is synced to the authenticated thread owner via
 * Replicache and carries the raw `reasoning` (thinking), `narration`, and
 * tool-call previews — which can echo internal artifact-engine details and
 * stored user-memory. Do NOT reuse it (or `SyncedChatMessage`) for a shared /
 * public thread reader if the "Share thread" affordance is ever wired up; a
 * shared read path needs its own serializer that projects only `role` +
 * `content` (and scrubbed tool calls) and drops `reasoning`/`narration`.
 */
function serializeChatMessage(m: ChatMessage): SyncedChatMessage {
  return syncedChatMessageSchema.parse({
    id: m.id,
    userId: m.userId,
    threadId: m.threadId,
    role: m.role,
    content: m.content,
    reasoning: m.reasoning ?? null,
    reasoningMs: m.reasoningMs ?? null,
    status: m.status,
    errorKind: m.errorKind ?? null,
    toolCalls: m.toolCalls ?? null,
    narration: m.narration ?? null,
    usage: m.usage ?? null,
    runId: m.runId,
    rowVersion: m.rowVersion,
    createdAt: toRequiredIso(m.createdAt, "chatMessages.createdAt"),
    updatedAt: toIso(m.updatedAt),
  });
}
