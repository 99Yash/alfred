import { chatMessages, chatThreads } from "@alfred/db/schemas";
import type {
  ChatAttachmentCreateArgs,
  ChatMessageCreateArgs,
  ChatThreadCreateArgs,
  ChatThreadDeleteArgs,
  ChatThreadRenameArgs,
  ChatThreadSetPinnedArgs,
} from "@alfred/sync";
import { and, eq, sql } from "drizzle-orm";
import type { DbTransaction } from "@alfred/db";

// Only the user side writes through Replicache; the worker writes replies. Idempotent on id.

export async function chatThreadCreate(
  tx: DbTransaction,
  args: ChatThreadCreateArgs,
  userId: string,
): Promise<void> {
  await tx
    .insert(chatThreads)
    .values({
      id: args.id,
      userId,
      lastMessageAt: new Date(args.createdAt),
      createdAt: new Date(args.createdAt),
    })
    .onConflictDoNothing();
}

export async function chatMessageCreate(
  tx: DbTransaction,
  args: ChatMessageCreateArgs,
  userId: string,
): Promise<void> {
  await tx
    .insert(chatMessages)
    .values({
      id: args.id,
      userId,
      threadId: args.threadId,
      role: "user",
      content: args.content,
      status: "complete",
      createdAt: new Date(args.createdAt),
    })
    .onConflictDoNothing();
  await tx
    .update(chatThreads)
    .set({
      lastMessageAt: new Date(args.createdAt),
      rowVersion: sql`${chatThreads.rowVersion} + 1`,
    })
    .where(and(eq(chatThreads.id, args.threadId), eq(chatThreads.userId, userId)));
}

/**
 * Client-only (ADR-0065): the server cannot trust a client descriptor here.
 * The turn endpoint writes `chat_attachments` after it checks the object.
 */
export async function chatAttachmentCreate(
  _tx: DbTransaction,
  _args: ChatAttachmentCreateArgs,
  _userId: string,
): Promise<void> {
  return;
}

export async function chatThreadRename(
  tx: DbTransaction,
  args: ChatThreadRenameArgs,
  userId: string,
): Promise<void> {
  await tx
    .update(chatThreads)
    .set({ title: args.title, rowVersion: sql`${chatThreads.rowVersion} + 1` })
    .where(and(eq(chatThreads.id, args.id), eq(chatThreads.userId, userId)));
}

export async function chatThreadSetPinned(
  tx: DbTransaction,
  args: ChatThreadSetPinnedArgs,
  userId: string,
): Promise<void> {
  await tx
    .update(chatThreads)
    .set({ pinned: args.pinned, rowVersion: sql`${chatThreads.rowVersion} + 1` })
    .where(and(eq(chatThreads.id, args.id), eq(chatThreads.userId, userId)));
}

/** Messages cascade by FK. Bucket objects are cleaned by the follow-up. */
export async function chatThreadDelete(
  tx: DbTransaction,
  args: ChatThreadDeleteArgs,
  userId: string,
): Promise<void> {
  await tx
    .delete(chatThreads)
    .where(and(eq(chatThreads.id, args.id), eq(chatThreads.userId, userId)));
}
