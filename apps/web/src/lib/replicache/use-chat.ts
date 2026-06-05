import {
  IDB_KEY,
  syncedChatMessageSchema,
  syncedChatThreadSchema,
  type SyncedChatMessage,
  type SyncedChatThread,
} from "@alfred/sync";
import { useEffect, useState } from "react";
import type { ReadTransaction } from "replicache";
import { useReplicache } from "./context";

/**
 * Reactive list of the user's chat threads, newest activity first. Mirrors
 * the `use-todos` subscription pattern (scan a prefix, zod-validate each row).
 */
export function useChatThreads(): SyncedChatThread[] {
  const rep = useReplicache();
  const [rows, setRows] = useState<SyncedChatThread[]>([]);

  useEffect(() => {
    if (!rep) {
      setRows([]);
      return;
    }
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
        setRows(parsed);
      },
    );
  }, [rep]);

  return rows;
}

/**
 * Reactive list of one thread's messages in chronological order. Returns an
 * empty array for a brand-new (unsent) thread.
 */
export function useChatMessages(threadId: string | undefined): SyncedChatMessage[] {
  const rep = useReplicache();
  const [rows, setRows] = useState<SyncedChatMessage[]>([]);

  useEffect(() => {
    if (!rep || !threadId) {
      setRows([]);
      return;
    }
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
        setRows(parsed);
      },
    );
  }, [rep, threadId]);

  return rows;
}
