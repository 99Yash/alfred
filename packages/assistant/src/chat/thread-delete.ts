import type { DbTransaction } from "@alfred/db";
import {
  agentRuns,
  chatThreadRunMatch,
  chatThreads,
  runIsNotTerminal,
  sharedThreads,
} from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";

import { cancelRunInTx } from "@alfred/assistant/execution";

/** The text on each approval card that the delete rejects. */
const THREAD_DELETED_APPROVAL_REASON = "The conversation was deleted.";

/**
 * `afterCommit` holds the side effects of the run cancels (notifications, queue cleanup). Call it
 * one time, after the caller's transaction commits. It does not throw.
 */
export type ChatThreadDeleteResult =
  | { deleted: false }
  | { deleted: true; afterCommit: () => Promise<void> };

/**
 * Delete a thread of the user in the caller's transaction (journal.md section 3). A delete is a
 * soft delete: the thread leaves the UI, and its messages, attachments, and memories stay. Its
 * share links stop, because a revoke is a hard delete (ADR-0102). Its live chat runs stop in the
 * same transaction: a run has no FK to its thread, so without the cancel a card it staged stays
 * decidable and its tool still runs.
 *
 * A repeated delete (a retry, another device) applies again. It keeps the first `deleted_at` and
 * cancels any run that is still live.
 *
 * Lock order: the `chat_threads` row first, then each live `agent_runs` row, then its
 * `action_stagings` rows and its children (`cancelRunInTx`).
 * - Turn admission locks the thread row before it inserts its run. If the delete locks first, the
 *   admission finds no live row and rolls back. If the admission locks first, the delete waits,
 *   and its run read starts after the admission commits, so it sees the new run.
 * - A step commit and the chat-turn close (`withStepLease`) lock `agent_runs` and then insert a
 *   chat message. That FK insert takes only `KEY SHARE` on the thread row. This update does not
 *   change a key column, so it takes `NO KEY UPDATE`, and the two locks do not conflict.
 * - The close bumps `lastMessageAt` in its own transaction, after the run lock is released.
 */
export async function deleteChatThreadInTx(
  tx: DbTransaction,
  args: { userId: string; threadId: string },
): Promise<ChatThreadDeleteResult> {
  const { userId, threadId } = args;

  const deleted = await tx
    .update(chatThreads)
    .set({
      deletedAt: sql`coalesce(${chatThreads.deletedAt}, now())`,
      rowVersion: sql`${chatThreads.rowVersion} + 1`,
    })
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .returning({ id: chatThreads.id });

  if (deleted.length === 0) return { deleted: false };

  await tx
    .delete(sharedThreads)
    .where(and(eq(sharedThreads.sourceThreadId, threadId), eq(sharedThreads.userId, userId)));

  // The active-run index allows one live chat run for each thread, so this loop is short.
  const live = await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(chatThreadRunMatch(agentRuns, { userId, threadId }), runIsNotTerminal(agentRuns.status)),
    );

  const obligations: Array<() => Promise<void>> = [];

  for (const { id } of live) {
    const { outcome, afterCommit } = await cancelRunInTx(tx, {
      runId: id,
      reason: "thread_deleted",
      pendingApprovalRejectReason: THREAD_DELETED_APPROVAL_REASON,
    });

    if (outcome === "cancelled") obligations.push(afterCommit);
  }

  return {
    deleted: true,
    afterCommit: async () => {
      for (const discharge of obligations) await discharge();
    },
  };
}
