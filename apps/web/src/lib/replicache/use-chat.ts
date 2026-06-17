import {
  IDB_KEY,
  syncedChatMessageSchema,
  syncedChatThreadSchema,
  type SyncedChatMessage,
  type SyncedChatThread,
} from "@alfred/sync";
import { useEffect, useState } from "react";
import type { ReadTransaction } from "replicache";
import type { AlfredReplicache } from "./client";
import { useReplicache } from "./context";

interface ReplicacheSnapshot<T> {
  rep: AlfredReplicache;
  value: T;
}

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

/**
 * Reactive single-thread lookup. Returns the synced thread row (for its title
 * + activity), or null while it hasn't synced yet / for a brand-new thread.
 */
export function useChatThread(threadId: string | undefined): SyncedChatThread | null {
  const rep = useReplicache();
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

  return snapshot?.rep === rep && snapshot.threadId === threadId ? snapshot.thread : null;
}

/**
 * Reactive list of one thread's messages in chronological order. Returns an
 * empty array for a brand-new (unsent) thread.
 */
export function useChatMessages(threadId: string | undefined): SyncedChatMessage[] {
  const rep = useReplicache();
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

  return snapshot?.rep === rep && snapshot.threadId === threadId ? snapshot.rows : [];
}
