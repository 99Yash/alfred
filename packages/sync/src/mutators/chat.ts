import type { WriteTransaction } from "replicache";
import { z } from "zod";
import { isoDateTimeStringSchema, MAX_ATTACHMENTS_PER_MESSAGE } from "@alfred/contracts";
import { SYNC_MODEL } from "../sync-model";
import type { SyncedChatAttachment, SyncedChatMessage, SyncedChatThread } from "../schemas";

// Only the user side has mutators. The worker writes assistant replies, and they arrive by pull.

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
  // Empty for an attachment-only message.
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
  // The server builds the storage key from it. Not on the synced row.
  threadId: chatId,
  name: z.string().min(1).max(255),
  mime: z.string().min(1).max(255),
  size: z.number().int().positive(),
  position: z
    .number()
    .int()
    .min(0)
    .max(MAX_ATTACHMENTS_PER_MESSAGE - 1),
  createdAt: isoDateTimeStringSchema,
});

export type ChatAttachmentCreateArgs = z.infer<typeof chatAttachmentCreateArgsSchema>;

async function readThread(tx: WriteTransaction, id: string): Promise<SyncedChatThread | null> {
  return SYNC_MODEL.chatthread.get(tx, { id });
}

/** Create an empty thread. Idempotent on id. */
export async function chatThreadCreateClient(
  tx: WriteTransaction,
  args: ChatThreadCreateArgs,
): Promise<void> {
  if (await SYNC_MODEL.chatthread.get(tx, { id: args.id })) return;

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

  await SYNC_MODEL.chatthread.put(tx, value);
}

/** No-op if the row has not synced yet. */
async function patchThread(
  tx: WriteTransaction,
  id: string,
  patch: Partial<SyncedChatThread>,
): Promise<void> {
  const thread = await readThread(tx, id);

  if (!thread) return;
  await SYNC_MODEL.chatthread.put(tx, {
    ...thread,
    ...patch,
    rowVersion: thread.rowVersion + 1,
  } satisfies SyncedChatThread);
}

export async function chatThreadRenameClient(
  tx: WriteTransaction,
  args: ChatThreadRenameArgs,
): Promise<void> {
  await patchThread(tx, args.id, { title: args.title });
}

export async function chatThreadSetPinnedClient(
  tx: WriteTransaction,
  args: ChatThreadSetPinnedArgs,
): Promise<void> {
  await patchThread(tx, args.id, { pinned: args.pinned });
}

/** Delete a thread with its messages and their attachments. */
export async function chatThreadDeleteClient(
  tx: WriteTransaction,
  args: ChatThreadDeleteArgs,
): Promise<void> {
  await SYNC_MODEL.chatthread.del(tx, { id: args.id });
  const deletedMessageIds = new Set<string>();
  const messages = await SYNC_MODEL.chatmsg.scan(tx);

  for (const message of messages) {
    if (message.threadId === args.id) {
      deletedMessageIds.add(message.id);
      await SYNC_MODEL.chatmsg.del(tx, { id: message.id });
    }
  }

  const attachments = await SYNC_MODEL.chatatt.scan(tx);

  for (const attachment of attachments) {
    if (deletedMessageIds.has(attachment.messageId)) {
      await SYNC_MODEL.chatatt.del(tx, { id: attachment.id });
    }
  }
}

/**
 * Show an already-uploaded attachment before the pull (ADR-0065). Idempotent on id.
 * The turn endpoint checks the object and writes the real row.
 */
export async function chatAttachmentCreateClient(
  tx: WriteTransaction,
  args: ChatAttachmentCreateArgs,
): Promise<void> {
  if (await SYNC_MODEL.chatatt.get(tx, { id: args.id })) return;

  const value: SyncedChatAttachment = {
    id: args.id,
    messageId: args.messageId,
    name: args.name,
    mime: args.mime,
    size: args.size,
    position: args.position,
    status: "ready",
    rowVersion: 0,
    createdAt: args.createdAt,
    updatedAt: args.createdAt,
  };

  await SYNC_MODEL.chatatt.put(tx, value);
}

/** Append the user's message and bump the thread's lastMessageAt. Idempotent on id. */
export async function chatMessageCreateClient(
  tx: WriteTransaction,
  args: ChatMessageCreateArgs,
): Promise<void> {
  if (!(await SYNC_MODEL.chatmsg.get(tx, { id: args.id }))) {
    const message: SyncedChatMessage = {
      id: args.id,
      userId: args.userId,
      threadId: args.threadId,
      role: "user",
      content: args.content,
      reasoning: null,
      reasoningMs: null,
      status: "complete",
      errorKind: null,
      toolCalls: null,
      narration: null,
      usage: null,
      runId: null,
      rowVersion: 0,
      createdAt: args.createdAt,
      updatedAt: args.createdAt,
    };

    await SYNC_MODEL.chatmsg.put(tx, message);
  }

  const thread = await readThread(tx, args.threadId);

  if (thread) {
    await SYNC_MODEL.chatthread.put(tx, {
      ...thread,
      lastMessageAt: args.createdAt,
      rowVersion: thread.rowVersion + 1,
      updatedAt: args.createdAt,
    } satisfies SyncedChatThread);
  }
}
