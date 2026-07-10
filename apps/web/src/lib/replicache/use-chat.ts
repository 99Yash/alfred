import {
  IDB_KEY,
  syncedChatAttachmentSchema,
  syncedChatMessageSchema,
  syncedChatThreadSchema,
  type SyncedChatAttachment,
  type SyncedChatMessage,
  type SyncedChatThread,
} from "@alfred/sync";
import { useEffect, useState } from "react";
import type { ReadTransaction } from "replicache";
import type { AlfredReplicache, ReplicacheSnapshot } from "./client";
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
    const prefix = IDB_KEY.CHAT_THREAD({});
    return rep.subscribe(
      async (tx: ReadTransaction) => tx.scan({ prefix }).values().toArray(),
      (values) => {
        const parsed: SyncedChatThread[] = [];
        for (const value of values) {
          const result = syncedChatThreadSchema.safeParse(value);
          if (result.success) parsed.push(result.data);
        }
        parsed.sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
        setSnapshot({ rep, value: parsed });
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
    rep: AlfredReplicache;
    threadId: string;
    thread: SyncedChatThread | null;
  } | null>(null);

  useEffect(() => {
    if (!rep || !threadId) return;
    return rep.subscribe(
      async (tx: ReadTransaction) => tx.get(IDB_KEY.CHAT_THREAD({ id: threadId })),
      (value) => {
        const result = syncedChatThreadSchema.safeParse(value);
        setSnapshot({ rep, threadId, thread: result.success ? result.data : null });
      },
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
    rep: AlfredReplicache;
    threadId: string;
    rows: SyncedChatMessage[];
  } | null>(null);

  useEffect(() => {
    if (!rep || !threadId) return;
    const prefix = IDB_KEY.CHAT_MESSAGE({});
    return rep.subscribe(
      async (tx: ReadTransaction) => tx.scan({ prefix }).values().toArray(),
      (values) => {
        const parsed: SyncedChatMessage[] = [];
        for (const value of values) {
          const result = syncedChatMessageSchema.safeParse(value);
          if (result.success && result.data.threadId === threadId) parsed.push(result.data);
        }
        parsed.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        setSnapshot({ rep, threadId, rows: parsed });
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
    rep: AlfredReplicache;
    threadId: string;
    byMessage: Record<string, SyncedChatAttachment[]>;
  } | null>(null);

  useEffect(() => {
    if (!rep || !threadId) return;
    const messagePrefix = IDB_KEY.CHAT_MESSAGE({});
    const attachmentPrefix = IDB_KEY.CHAT_ATTACHMENT({});
    return rep.subscribe(
      async (tx: ReadTransaction) => ({
        messages: await tx.scan({ prefix: messagePrefix }).values().toArray(),
        attachments: await tx.scan({ prefix: attachmentPrefix }).values().toArray(),
      }),
      ({ messages, attachments }) => {
        const messageIds = new Set<string>();
        for (const value of messages) {
          const result = syncedChatMessageSchema.safeParse(value);
          if (result.success && result.data.threadId === threadId) {
            messageIds.add(result.data.id);
          }
        }
        const byMessage: Record<string, SyncedChatAttachment[]> = {};
        for (const value of attachments) {
          const result = syncedChatAttachmentSchema.safeParse(value);
          if (!result.success) continue;
          if (!messageIds.has(result.data.messageId)) continue;
          (byMessage[result.data.messageId] ??= []).push(result.data);
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
