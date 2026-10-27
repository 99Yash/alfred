import {
  SYNC_MODEL,
  type SyncedChatAttachment,
  type SyncedChatMessage,
  type SyncedChatThread,
} from "@alfred/sync";
import { useCallback, useEffect, useMemo } from "react";
import type { ReadTransaction } from "replicache";
import { clearPendingTurn, usePendingTurn } from "~/lib/chat/pending-turn";
import { useReplicacheSubscription } from "./use-replicache-subscription";

const scanThreads = (tx: ReadTransaction) => SYNC_MODEL.chatthread.scan(tx);

const byLastMessageDesc = (threads: SyncedChatThread[]) =>
  threads.toSorted((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));

/** Chat threads, newest activity first. */
export function useChatThreads(): SyncedChatThread[] {
  return useReplicacheSubscription(scanThreads, byLastMessageDesc).data ?? [];
}

export interface ChatThreadState {
  thread: SyncedChatThread | null;
  loading: boolean;
}

/** Keeps "not loaded" apart from "not found". */
export function useChatThread(threadId: string | undefined): ChatThreadState {
  const query = useMemo(
    () =>
      threadId ? (tx: ReadTransaction) => SYNC_MODEL.chatthread.get(tx, { id: threadId }) : null,
    [threadId],
  );

  const { data, loading } = useReplicacheSubscription(query);

  return { thread: data ?? null, loading };
}

export interface ChatMessagesState {
  messages: SyncedChatMessage[];
  loading: boolean;
  error: string | null;
  retry: () => void;
}

const scanMessages = (tx: ReadTransaction) => SYNC_MODEL.chatmsg.scan(tx);

/** Does not report an unresolved subscription as empty. */
export function useChatMessages(threadId: string | undefined): ChatMessagesState {
  const selectThread = useCallback(
    (rows: SyncedChatMessage[]) =>
      rows
        .filter((row) => row.threadId === threadId)
        .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [threadId],
  );

  const {
    data: current,
    loading,
    error,
    retry,
  } = useReplicacheSubscription(threadId ? scanMessages : null, selectThread);

  // The sent message shows before its mirror; the synced row replaces it by id.
  const pendingMessage = usePendingTurn(threadId)?.message ?? null;

  const pendingSynced =
    pendingMessage !== null &&
    current !== undefined &&
    current.some((m) => m.id === pendingMessage.id);

  // Drop the copy once synced, so a later delete of the real row cannot bring it back.
  useEffect(() => {
    if (pendingMessage && pendingSynced)
      clearPendingTurn(pendingMessage.threadId, pendingMessage.id);
  }, [pendingMessage, pendingSynced]);

  const messages = useMemo(() => {
    const rows = current ?? [];

    return pendingMessage && !pendingSynced ? [...rows, pendingMessage] : rows;
  }, [current, pendingMessage, pendingSynced]);

  return { messages, loading, error, retry };
}

const scanMessagesAndAttachments = async (tx: ReadTransaction) => ({
  messages: await SYNC_MODEL.chatmsg.scan(tx),
  attachments: await SYNC_MODEL.chatatt.scan(tx),
});

/** A thread's attachments by message id (ADR-0065). One subscription per thread, not per message. */
export function useChatAttachmentsByMessage(
  threadId: string | undefined,
): Record<string, SyncedChatAttachment[]> {
  const selectThread = useCallback(
    ({
      messages,
      attachments,
    }: {
      messages: SyncedChatMessage[];
      attachments: SyncedChatAttachment[];
    }) => {
      const messageIds = new Set<string>();

      for (const message of messages) {
        if (message.threadId === threadId) {
          messageIds.add(message.id);
        }
      }

      const byMessage: Record<string, SyncedChatAttachment[]> = {};

      for (const attachment of attachments) {
        if (!messageIds.has(attachment.messageId)) continue;
        (byMessage[attachment.messageId] ??= []).push(attachment);
      }

      for (const list of Object.values(byMessage)) {
        list.sort(
          (a, b) =>
            a.position - b.position ||
            a.createdAt.localeCompare(b.createdAt) ||
            a.id.localeCompare(b.id),
        );
      }

      return byMessage;
    },
    [threadId],
  );

  const synced = useReplicacheSubscription(
    threadId ? scanMessagesAndAttachments : null,
    selectThread,
  ).data;

  const pendingTurn = usePendingTurn(threadId);

  // The pending message's files, until the mirror writes them (before the message, so one tick).
  return useMemo(() => {
    const byMessage = synced ?? {};

    if (!pendingTurn || pendingTurn.attachments.length === 0) return byMessage;

    if (byMessage[pendingTurn.message.id]) return byMessage;

    return { ...byMessage, [pendingTurn.message.id]: pendingTurn.attachments };
  }, [synced, pendingTurn]);
}
