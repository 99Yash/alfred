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
import type { DbTx, ServerMutatorCtx } from "./mutator";

// Chat (streaming-chat plan). Only the user side mutates via Replicache:
// opening a thread and appending the user's message. The assistant reply is
// worker-written on completion. Both are idempotent on id so at-least-once
// redelivery is a no-op.

/** Open a new chat thread. Idempotent on id (client mints it before push). */
export async function chatThreadCreate(
  tx: DbTx,
  args: ChatThreadCreateArgs,
  ctx: ServerMutatorCtx,
): Promise<void> {
  await tx
    .insert(chatThreads)
    .values({
      id: args.id,
      userId: ctx.userId,
      lastMessageAt: new Date(args.createdAt),
      createdAt: new Date(args.createdAt),
    })
    .onConflictDoNothing();
}

/** Append the user's message and float its thread to the top of the list. */
export async function chatMessageCreate(
  tx: DbTx,
  args: ChatMessageCreateArgs,
  ctx: ServerMutatorCtx,
): Promise<void> {
  await tx
    .insert(chatMessages)
    .values({
      id: args.id,
      userId: ctx.userId,
      threadId: args.threadId,
      role: "user",
      content: args.content,
      status: "complete",
      createdAt: new Date(args.createdAt),
    })
    .onConflictDoNothing();
  // Bump lastMessageAt only on a thread this user owns.
  await tx
    .update(chatThreads)
    .set({
      lastMessageAt: new Date(args.createdAt),
      rowVersion: sql`${chatThreads.rowVersion} + 1`,
    })
    .where(and(eq(chatThreads.id, args.threadId), eq(chatThreads.userId, ctx.userId)));
}

/**
 * Optimistic-only attachment mutator (ADR-0065). The client uses this to render
 * a just-uploaded image immediately, but the server intentionally does not
 * persist from this Replicache mutation: accepting a client descriptor here
 * would mark an object `ready` without proving the bucket object exists or that
 * its bytes match the declared image type. The `/api/chat/threads/:id/turn`
 * endpoint is the canonical write path because it can verify the object before
 * inserting `chat_attachments`.
 */
export async function chatAttachmentCreate(
  _tx: DbTx,
  _args: ChatAttachmentCreateArgs,
  _ctx: ServerMutatorCtx,
): Promise<void> {
  return;
}

/** Rename a thread. No-op on a thread this user doesn't own. */
export async function chatThreadRename(
  tx: DbTx,
  args: ChatThreadRenameArgs,
  ctx: ServerMutatorCtx,
): Promise<void> {
  await tx
    .update(chatThreads)
    .set({ title: args.title, rowVersion: sql`${chatThreads.rowVersion} + 1` })
    .where(and(eq(chatThreads.id, args.id), eq(chatThreads.userId, ctx.userId)));
}

/** Pin / unpin a thread. No-op on a thread this user doesn't own. */
export async function chatThreadSetPinned(
  tx: DbTx,
  args: ChatThreadSetPinnedArgs,
  ctx: ServerMutatorCtx,
): Promise<void> {
  await tx
    .update(chatThreads)
    .set({ pinned: args.pinned, rowVersion: sql`${chatThreads.rowVersion} + 1` })
    .where(and(eq(chatThreads.id, args.id), eq(chatThreads.userId, ctx.userId)));
}

/**
 * Hard-delete a thread. Its `chat_messages` cascade via the FK; the next
 * pull diff drops the thread + message rows from the client. No-op on a
 * thread this user doesn't own.
 */
export async function chatThreadDelete(
  tx: DbTx,
  args: ChatThreadDeleteArgs,
  ctx: ServerMutatorCtx,
): Promise<void> {
  await tx
    .delete(chatThreads)
    .where(and(eq(chatThreads.id, args.id), eq(chatThreads.userId, ctx.userId)));
}
