import type { WriteTransaction } from "replicache";
import { z } from "zod";
import { IDB_KEY, normalizeToReadonlyJSON } from "../keys";
import {
  isoDateTimeStringSchema,
  syncedChatAttachmentSchema,
  syncedChatMessageSchema,
  syncedChatThreadSchema,
} from "../schemas";
import type { SyncedChatAttachment, SyncedChatMessage, SyncedChatThread } from "../types";
import { parseSyncedValue, readSyncedValue } from "./read";

/**
 * Client-side chat mutators (streaming-chat plan). Only the *user* side is a
 * Replicache mutator: creating a thread and appending the user's message.
 * The assistant reply streams live over SSE and is persisted server-side by
 * the chat worker, then synced via pull — there is no client mutator for it.
 *
 * Optimistic patches are best-effort; a missing-row race no-ops and lets the
 * next pull rebase over the canonical state.
 */

const chatId = z.string().min(1).max(100);

export const chatThreadCreateArgsSchema = z.object({
  id: chatId,
  userId: z.string().min(1).max(100),
  createdAt: isoDateTimeStringSchema,
});
export type ChatThreadCreateArgs = z.infer<typeof chatThreadCreateArgsSchema>;

export const chatMessageCreateArgsSchema = z.object({
  id: chatId,
  threadId: chatId,
  userId: z.string().min(1).max(100),
  // May be empty when the message carries only an attachment (image-only send).
  content: z.string().min(0).max(100_000),
  createdAt: isoDateTimeStringSchema,
});
export type ChatMessageCreateArgs = z.infer<typeof chatMessageCreateArgsSchema>;

export const chatThreadRenameArgsSchema = z.object({
  id: chatId,
  title: z.string().min(1).max(200),
});
export type ChatThreadRenameArgs = z.infer<typeof chatThreadRenameArgsSchema>;

export const chatThreadSetPinnedArgsSchema = z.object({
  id: chatId,
  pinned: z.boolean(),
});
export type ChatThreadSetPinnedArgs = z.infer<typeof chatThreadSetPinnedArgsSchema>;

export const chatThreadDeleteArgsSchema = z.object({
  id: chatId,
});
export type ChatThreadDeleteArgs = z.infer<typeof chatThreadDeleteArgsSchema>;

export const chatAttachmentCreateArgsSchema = z.object({
  id: chatId,
  messageId: chatId,
  // The thread the message belongs to — the server rebuilds the storage key
  // from it; not stored on the synced row.
  threadId: chatId,
  name: z.string().min(1).max(255),
  mime: z.string().min(1).max(255),
  size: z.number().int().positive(),
  createdAt: isoDateTimeStringSchema,
});
export type ChatAttachmentCreateArgs = z.infer<typeof chatAttachmentCreateArgsSchema>;

async function readThread(tx: WriteTransaction, id: string): Promise<SyncedChatThread | null> {
  return readSyncedValue(tx, IDB_KEY.CHAT_THREAD({ id }), syncedChatThreadSchema);
}

/** Create an empty thread. Idempotent on id. */
export async function chatThreadCreateClient(
  tx: WriteTransaction,
  args: ChatThreadCreateArgs,
): Promise<void> {
  if (await tx.has(IDB_KEY.CHAT_THREAD({ id: args.id }))) return;
  const value: SyncedChatThread = {
    id: args.id,
    userId: args.userId,
    title: null,
    lastMessageAt: args.createdAt,
    pinned: false,
    rowVersion: 0,
    createdAt: args.createdAt,
    updatedAt: args.createdAt,
  };
  await tx.set(IDB_KEY.CHAT_THREAD({ id: args.id }), normalizeToReadonlyJSON(value));
}

/** Patch a thread's optimistic field set. No-op if the row hasn't synced yet. */
async function patchThread(
  tx: WriteTransaction,
  id: string,
  patch: Partial<SyncedChatThread>,
): Promise<void> {
  const thread = await readThread(tx, id);
  if (!thread) return;
  await tx.set(
    IDB_KEY.CHAT_THREAD({ id }),
    normalizeToReadonlyJSON({
      ...thread,
      ...patch,
      rowVersion: thread.rowVersion + 1,
    } satisfies SyncedChatThread),
  );
}

/** Rename a thread's title optimistically. */
export async function chatThreadRenameClient(
  tx: WriteTransaction,
  args: ChatThreadRenameArgs,
): Promise<void> {
  await patchThread(tx, args.id, { title: args.title });
}

/** Pin / unpin a thread optimistically. */
export async function chatThreadSetPinnedClient(
  tx: WriteTransaction,
  args: ChatThreadSetPinnedArgs,
): Promise<void> {
  await patchThread(tx, args.id, { pinned: args.pinned });
}

/**
 * Delete a thread and its messages optimistically. The canonical delete is a
 * hard DB delete (messages cascade); the next pull confirms the removal.
 */
export async function chatThreadDeleteClient(
  tx: WriteTransaction,
  args: ChatThreadDeleteArgs,
): Promise<void> {
  await tx.del(IDB_KEY.CHAT_THREAD({ id: args.id }));
  const deletedMessageIds = new Set<string>();
  const messages = await tx
    .scan({ prefix: IDB_KEY.CHAT_MESSAGE({}) })
    .entries()
    .toArray();
  for (const [key, value] of messages) {
    const message = parseSyncedValue(value, syncedChatMessageSchema);
    if (message?.threadId === args.id) {
      deletedMessageIds.add(message.id);
      await tx.del(key);
    }
  }
  // Drop the deleted messages' attachments too (server cascades the rows +
  // reaps the bucket objects; this keeps the optimistic store consistent).
  const attachments = await tx
    .scan({ prefix: IDB_KEY.CHAT_ATTACHMENT({}) })
    .entries()
    .toArray();
  for (const [key, value] of attachments) {
    const att = parseSyncedValue(value, syncedChatAttachmentSchema);
    if (att && deletedMessageIds.has(att.messageId)) {
      await tx.del(key);
    }
  }
}

/**
 * Optimistically record an uploaded attachment on a just-sent message
 * (ADR-0065). The bytes are already in the bucket (uploaded during
 * composition); this writes the display row so the image renders in its bubble
 * without waiting for the pull. Phase 1 is images — the row lands `ready`. The
 * server mutator rebuilds the storage key and persists the canonical row.
 * Idempotent on id.
 */
export async function chatAttachmentCreateClient(
  tx: WriteTransaction,
  args: ChatAttachmentCreateArgs,
): Promise<void> {
  if (await tx.has(IDB_KEY.CHAT_ATTACHMENT({ id: args.id }))) return;
  const value: SyncedChatAttachment = {
    id: args.id,
    messageId: args.messageId,
    name: args.name,
    mime: args.mime,
    size: args.size,
    status: "ready",
    rowVersion: 0,
    createdAt: args.createdAt,
    updatedAt: args.createdAt,
  };
  await tx.set(IDB_KEY.CHAT_ATTACHMENT({ id: args.id }), normalizeToReadonlyJSON(value));
}

/** Append the user's message and bump the thread's lastMessageAt. Idempotent on id. */
export async function chatMessageCreateClient(
  tx: WriteTransaction,
  args: ChatMessageCreateArgs,
): Promise<void> {
  if (!(await tx.has(IDB_KEY.CHAT_MESSAGE({ id: args.id })))) {
    const message: SyncedChatMessage = {
      id: args.id,
      userId: args.userId,
      threadId: args.threadId,
      role: "user",
      content: args.content,
      reasoning: null,
      reasoningMs: null,
      status: "complete",
      toolCalls: null,
      narration: null,
      runId: null,
      rowVersion: 0,
      createdAt: args.createdAt,
      updatedAt: args.createdAt,
    };
    await tx.set(IDB_KEY.CHAT_MESSAGE({ id: args.id }), normalizeToReadonlyJSON(message));
  }

  // Optimistically float the thread to the top of the list.
  const thread = await readThread(tx, args.threadId);
  if (thread) {
    await tx.set(
      IDB_KEY.CHAT_THREAD({ id: args.threadId }),
      normalizeToReadonlyJSON({
        ...thread,
        lastMessageAt: args.createdAt,
        rowVersion: thread.rowVersion + 1,
        updatedAt: args.createdAt,
      } satisfies SyncedChatThread),
    );
  }
}
