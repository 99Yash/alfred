import {
  SYNC_MODEL,
  type SyncedChatAttachment,
  type SyncedChatMessage,
  type SyncedChatThread,
} from "@alfred/sync";
import { useEffect, useState } from "react";
import type { ReadTransaction, Replicache } from "replicache";
import type { ClientMutators } from "@alfred/sync";
import type { ReplicacheSnapshot } from "./client";
import { useReplicache, useReplicacheStatus } from "./context";

/**
 * Reactive list of the user's chat threads, newest activity first. Mirrors
 * the `use-todos` subscription pattern (scan a prefix, zod-validate each row).
 */
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

/** Reactive single-thread lookup with unresolved and resolved-empty kept distinct. */
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
      (tx: ReadTransaction) => SYNC_MODEL.chatthread.get(tx, threadId),
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

/** Reactive message list that does not expose an unresolved subscription as empty. */
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
  return {
    messages: current ?? [],
    loading:
      Boolean(threadId) &&
      !error &&
      (current === null || (current.length === 0 && initialPullPending)),
    error,
    retry,
  };
}

/**
 * Reactive map of a thread's attachments grouped by message id (ADR-0065).
 * Read once per thread (a flat `chatatt/` scan, filtered/grouped client-side)
 * and looked up per bubble — cheaper than one subscription per message. The
 * empty object is stable-enough; consumers index by `message.id`.
 */
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

  return snapshot?.rep === rep && snapshot.threadId === threadId ? snapshot.byMessage : {};
}
