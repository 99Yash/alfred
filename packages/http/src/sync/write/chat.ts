import { deleteChatThreadInTx } from "@alfred/assistant/chat";
import { chatMessages, chatThreadIsLive, chatThreads } from "@alfred/db/schemas";
import type {
  ChatAttachmentCreateArgs,
  ChatMessageCreateArgs,
  ChatThreadCreateArgs,
  ChatThreadDeleteArgs,
  ChatThreadRenameArgs,
  ChatThreadSetApprovalModeArgs,
  ChatThreadSetPinnedArgs,
} from "@alfred/sync";
import { and, eq, sql } from "drizzle-orm";
import type { DbTransaction } from "@alfred/db";
import { MutatorForbiddenError } from "../authz";
import { policySetDefaultMode } from "./action-policies";
import type { MutatorResult } from "./mutator";

// Only the user side writes through Replicache; the worker writes replies. Idempotent on id.

/** This thread of this user, if it is live. A deleted thread takes no write (journal.md section 3). */
const ownedLiveThread = (threadId: string, userId: string) =>
  and(
    eq(chatThreads.id, threadId),
    eq(chatThreads.userId, userId),
    chatThreadIsLive(chatThreads.deletedAt),
  );

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
      fullAutonomy: args.fullAutonomy ?? false,
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

  // The message first, then the thread row: the same order as turn admission, so the two paths
  // cannot deadlock on one message id. The thread row lock orders this against a delete. If the
  // thread is deleted, the throw rolls back the insert: a message never lands in a deleted thread.
  const [thread] = await tx
    .update(chatThreads)
    .set({
      lastMessageAt: new Date(args.createdAt),
      rowVersion: sql`${chatThreads.rowVersion} + 1`,
    })
    .where(ownedLiveThread(args.threadId, userId))
    .returning({ id: chatThreads.id });

  if (!thread) throw new MutatorForbiddenError("Chat thread is unavailable");
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
    .where(ownedLiveThread(args.id, userId));
}

export async function chatThreadSetPinned(
  tx: DbTransaction,
  args: ChatThreadSetPinnedArgs,
  userId: string,
): Promise<void> {
  await tx
    .update(chatThreads)
    .set({ pinned: args.pinned, rowVersion: sql`${chatThreads.rowVersion} + 1` })
    .where(ownedLiveThread(args.id, userId));
}

/**
 * One savepoint owns the thread flag and global default. A failure rolls back both writes.
 * The registry busts the policy cache after commit when Review or Auto changes the default.
 */
export async function chatThreadSetApprovalMode(
  tx: DbTransaction,
  args: ChatThreadSetApprovalModeArgs,
  userId: string,
): Promise<void> {
  const [thread] = await tx
    .update(chatThreads)
    .set({ fullAutonomy: args.mode === "full", rowVersion: sql`${chatThreads.rowVersion} + 1` })
    .where(ownedLiveThread(args.id, userId))
    .returning({ id: chatThreads.id });

  if (!thread) throw new MutatorForbiddenError("Chat thread is unavailable");

  if (args.mode !== "full") {
    await policySetDefaultMode(tx, { mode: args.mode === "auto" ? "autonomy" : "gated" }, userId);
  }
}

/** The transition is `deleteChatThreadInTx`. The run cancels owe work after the push commits. */
export async function chatThreadDelete(
  tx: DbTransaction,
  args: ChatThreadDeleteArgs,
  userId: string,
): Promise<MutatorResult> {
  const result = await deleteChatThreadInTx(tx, { userId, threadId: args.id });

  if (!result.deleted) return { applied: false };

  return {
    applied: true,
    followUps: [{ kind: "dischargeThreadDelete", afterCommit: result.afterCommit }],
  };
}
