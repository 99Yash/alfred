import type { WriteTransaction } from "replicache";
import { z } from "zod";
import { IDB_KEY, normalizeToReadonlyJSON } from "../keys";
import { isoDateTimeStringSchema } from "../schemas";
import type { SyncedChatMessage, SyncedChatThread } from "../types";

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
  content: z.string().min(1).max(100_000),
  createdAt: isoDateTimeStringSchema,
});
export type ChatMessageCreateArgs = z.infer<typeof chatMessageCreateArgsSchema>;

async function readThread(tx: WriteTransaction, id: string): Promise<SyncedChatThread | null> {
  const value = await tx.get(IDB_KEY.CHAT_THREAD({ id }));
  return value ? (value as unknown as SyncedChatThread) : null;
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
    rowVersion: 0,
    createdAt: args.createdAt,
    updatedAt: args.createdAt,
  };
  await tx.set(IDB_KEY.CHAT_THREAD({ id: args.id }), normalizeToReadonlyJSON(value));
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
