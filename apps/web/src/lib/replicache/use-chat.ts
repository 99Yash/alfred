import {
  SYNC_MODEL,
  type SyncedChatAttachment,
  type SyncedChatMessage,
  type SyncedChatThread,
} from "@alfred/sync";
import { useEffect, useMemo, useState } from "react";
import type { ReadTransaction, Replicache } from "replicache";
import type { ClientMutators } from "@alfred/sync";
import { clearPendingTurn, usePendingTurn } from "~/lib/chat/pending-turn";
import type { ReplicacheSnapshot } from "./client";
import { useReplicache, useReplicacheStatus } from "./context";

/** Chat threads, newest activity first. */
export function useChatThreads(): SyncedChatThread[] {
  const rep = useReplicache();
  const [snapshot, setSnapshot] = useState<ReplicacheSnapshot<SyncedChatThread[]> | null>(null);

  useEffect(() => {
    if (!rep) return;

    return rep.subscribe(
      (tx: ReadTransaction) => SYNC_MODEL.chatthread.scan(tx),
      (threads) => {
        threads.sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
        setSnapshot({ rep, value: threads });
      },
    );
  }, [rep]);

  return snapshot?.rep === rep ? snapshot.value : [];
}

export interface ChatThreadState {
  thread: SyncedChatThread | null;
  loading: boolean;
}

/** Keeps "not loaded" apart from "not found". */
export function useChatThread(threadId: string | undefined): ChatThreadState {
  const { rep, loadError, pullError, initialPullPending } = useReplicacheStatus();

  const [snapshot, setSnapshot] = useState<{
    rep: Replicache<ClientMutators>;
    threadId: string;
    thread: SyncedChatThread | null;
  } | null>(null);

  useEffect(() => {
    if (!rep || !threadId) return;

    return rep.subscribe(
      (tx: ReadTransaction) => SYNC_MODEL.chatthread.get(tx, { id: threadId }),
      (thread) => setSnapshot({ rep, threadId, thread }),
    );
  }, [rep, threadId]);

  const current =
    snapshot?.rep === rep && snapshot.threadId === threadId ? snapshot.thread : undefined;

  const error = loadError ?? pullError;

  return {
    thread: current ?? null,
    loading:
      Boolean(threadId) &&
      !error &&
      (current === undefined || (current === null && initialPullPending)),
  };
}

export interface ChatMessagesState {
  messages: SyncedChatMessage[];
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/** Does not report an unresolved subscription as empty. */
export function useChatMessages(threadId: string | undefined): ChatMessagesState {
  const { rep, loadError, pullError, initialPullPending, retry } = useReplicacheStatus();

  const [snapshot, setSnapshot] = useState<{
    rep: Replicache<ClientMutators>;
    threadId: string;
    rows: SyncedChatMessage[];
  } | null>(null);

  useEffect(() => {
    if (!rep || !threadId) return;

    return rep.subscribe(
      (tx: ReadTransaction) => SYNC_MODEL.chatmsg.scan(tx),
      (values) => {
        const rows = values.filter((value) => value.threadId === threadId);
        rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        setSnapshot({ rep, threadId, rows });
      },
    );
  }, [rep, threadId]);

  const current = snapshot?.rep === rep && snapshot.threadId === threadId ? snapshot.rows : null;
  const error = loadError ?? pullError;

  // The sent message shows before its mirror; the synced row replaces it by id.
  const pendingMessage = usePendingTurn(threadId)?.message ?? null;

  const pendingSynced =
    pendingMessage !== null && current !== null && current.some((m) => m.id === pendingMessage.id);

  // Drop the copy once synced, so a later delete of the real row cannot bring it back.
  useEffect(() => {
    if (pendingMessage && pendingSynced)
      clearPendingTurn(pendingMessage.threadId, pendingMessage.id);
  }, [pendingMessage, pendingSynced]);

  const messages = useMemo(() => {
    const rows = current ?? [];

    return pendingMessage && !pendingSynced ? [...rows, pendingMessage] : rows;
  }, [current, pendingMessage, pendingSynced]);

  return {
    messages,
    loading:
      Boolean(threadId) &&
      !error &&
      (current === null || (current.length === 0 && initialPullPending)),
    error,
    retry,
  };
}

/** A thread's attachments by message id (ADR-0065). One subscription per thread, not per message. */
export function useChatAttachmentsByMessage(
  threadId: string | undefined,
): Record<string, SyncedChatAttachment[]> {
  const rep = useReplicache();

  const [snapshot, setSnapshot] = useState<{
    rep: Replicache<ClientMutators>;
    threadId: string;
    byMessage: Record<string, SyncedChatAttachment[]>;
  } | null>(null);

  useEffect(() => {
    if (!rep || !threadId) return;

    return rep.subscribe(
      async (tx: ReadTransaction) => ({
        messages: await SYNC_MODEL.chatmsg.scan(tx),
        attachments: await SYNC_MODEL.chatatt.scan(tx),
      }),
      ({ messages, attachments }) => {
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

        setSnapshot({ rep, threadId, byMessage });
      },
    );
  }, [rep, threadId]);

  const synced =
    snapshot?.rep === rep && snapshot.threadId === threadId ? snapshot.byMessage : null;

  const pendingTurn = usePendingTurn(threadId);

  // The pending message's files, until the mirror writes them (before the message, so one tick).
  return useMemo(() => {
    const byMessage = synced ?? {};

    if (!pendingTurn || pendingTurn.attachments.length === 0) return byMessage;

    if (byMessage[pendingTurn.message.id]) return byMessage;

    return { ...byMessage, [pendingTurn.message.id]: pendingTurn.attachments };
  }, [synced, pendingTurn]);
}
