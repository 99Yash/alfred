import { useCallback, useEffect, useMemo, useState } from "react";
import {
  isEmptyChatTurnInput,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_QUEUED_TURNS,
  type ChatModelTier,
} from "@alfred/contracts";

/** A message that waits for the in-flight turn, then starts its own. In memory only. */
export interface QueuedMessage {
  id: string;
  text: string;
  files: File[];
  tier: ChatModelTier;
  artifactTargetId?: string | undefined;
  retryAttachmentIds?: string[] | undefined;
  retryAttachmentMessageId?: string | undefined;
}

type Queues = Map<string, QueuedMessage[]>;

function queueKey(threadId: string | undefined): string {
  return threadId ?? "__new__";
}

function safeRandomId(): string {
  if (typeof crypto === "undefined")
    return `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return crypto.randomUUID?.() ?? `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface ChatQueue {
  /** This thread's FIFO, shown as chips above the composer. */
  queue: QueuedMessage[];
  /**
   * The new entry's id, or `null` when the entry is empty, over a cap, or the queue is full.
   * `front` puts a steer (#490) ahead of the waiting entries.
   */
  enqueue: (entry: Omit<QueuedMessage, "id">, position?: "back" | "front") => string | null;
  remove: (id: string) => void;
  /** Replace an entry's text. An edit that leaves nothing to send removes the entry. */
  update: (id: string, text: string) => void;
  /** Move an entry to the head, so it sends next. */
  promote: (id: string) => void;
  /** Call after the oldest entry has started. */
  dequeue: () => void;
  peek: () => QueuedMessage | undefined;
}

/**
 * Per-thread composer queue. Sends during a turn wait here and start when it ends.
 * A reload clears it. The bare `/chat` page uses the `__new__` key.
 */
export function useChatQueue(threadId: string | undefined): ChatQueue {
  const [queues, setQueues] = useState<Queues>(() => new Map());
  const key = queueKey(threadId);
  const queue = useMemo(() => queues.get(key) ?? [], [queues, key]);

  // Move `__new__` entries to the real thread after the first send navigates there.
  useEffect(() => {
    if (!threadId) return;
    setQueues((prev) => {
      const oldKey = "__new__";
      const oldQueue = prev.get(oldKey);

      if (!oldQueue || oldQueue.length === 0) return prev;
      const newQueue = prev.get(threadId) ?? [];
      // Merge, never drop: the new thread can already have entries after a fast double send.
      const merged = [...newQueue, ...oldQueue];

      if (merged.length === 0) return prev;
      const next = new Map(prev);
      next.set(threadId, merged);
      next.set(oldKey, []);

      // Bound memory, because entries hold `File` handles: drop empties, keep at most 20 threads.
      if (next.get(oldKey)?.length === 0) next.delete(oldKey);

      if (next.size > 20) {
        const firstKey = next.keys().next().value;

        if (firstKey && firstKey !== threadId && firstKey !== oldKey) next.delete(firstKey);
      }

      return next;
    });
  }, [threadId]);

  const enqueue = useCallback(
    (entry: Omit<QueuedMessage, "id">, position: "back" | "front" = "back"): string | null => {
      const text = entry.text.trim();
      const hasFiles = entry.files.length > 0;

      // The same "empty" rule as `useSendMessage` and `ChatShell`.
      if (
        isEmptyChatTurnInput({
          content: text,
          hasFiles,
          artifactTargetId: entry.artifactTargetId,
          retryAttachmentIds: entry.retryAttachmentIds,
        })
      )
        return null;

      // A queued turn skips the composer's attachment cap, so check it here.
      if (entry.files.length > MAX_ATTACHMENTS_PER_MESSAGE) return null;
      const normalized = text;

      if (
        isEmptyChatTurnInput({
          content: normalized,
          hasFiles,
          artifactTargetId: entry.artifactTargetId,
          retryAttachmentIds: entry.retryAttachmentIds,
        })
      )
        return null;

      // When full, reject so the draft stays in the composer.
      const currentLen = queues.get(key)?.length ?? 0;

      if (currentLen >= MAX_QUEUED_TURNS) return null;

      const id = safeRandomId();

      const queued: QueuedMessage = {
        id,
        text: normalized,
        files: entry.files,
        tier: entry.tier,
        artifactTargetId: entry.artifactTargetId,
        retryAttachmentIds: entry.retryAttachmentIds,
        retryAttachmentMessageId: entry.retryAttachmentMessageId,
      };

      setQueues((prev) => {
        const prevList = prev.get(key) ?? [];

        if (prevList.length >= MAX_QUEUED_TURNS) return prev;
        const next = new Map(prev);
        next.set(key, position === "front" ? [queued, ...prevList] : [...prevList, queued]);

        return next;
      });

      return id;
    },
    [key, queues],
  );

  const remove = useCallback(
    (id: string) => {
      setQueues((prev) => {
        const list = prev.get(key) ?? [];
        const next = list.filter((m) => m.id !== id);

        if (next.length === list.length) return prev;
        const map = new Map(prev);

        if (next.length === 0) map.delete(key);
        else map.set(key, next);

        return map;
      });
    },
    [key],
  );

  const update = useCallback(
    (id: string, text: string) => {
      setQueues((prev) => {
        const list = prev.get(key) ?? [];
        const entry = list.find((m) => m.id === id);

        if (!entry || entry.text === text) return prev;

        // The same "empty" rule as `enqueue`, so an emptied entry cannot block the flush.
        const empty = isEmptyChatTurnInput({
          content: text.trim(),
          hasFiles: entry.files.length > 0,
          artifactTargetId: entry.artifactTargetId,
          retryAttachmentIds: entry.retryAttachmentIds,
        });

        const next = empty
          ? list.filter((m) => m !== entry)
          : list.map((m) => (m === entry ? { ...m, text: text.trim() } : m));

        const map = new Map(prev);

        if (next.length === 0) map.delete(key);
        else map.set(key, next);

        return map;
      });
    },
    [key],
  );

  const promote = useCallback(
    (id: string) => {
      setQueues((prev) => {
        const list = prev.get(key) ?? [];
        const entry = list.find((m) => m.id === id);

        if (!entry || list[0] === entry) return prev;
        const map = new Map(prev);
        map.set(key, [entry, ...list.filter((m) => m !== entry)]);

        return map;
      });
    },
    [key],
  );

  const dequeue = useCallback(() => {
    setQueues((prev) => {
      const list = prev.get(key) ?? [];

      if (list.length === 0) return prev;
      const rest = list.slice(1);
      const map = new Map(prev);

      if (rest.length === 0) map.delete(key);
      else map.set(key, rest);

      return map;
    });
  }, [key]);

  const peek = useCallback(() => queue[0], [queue]);

  return { queue, enqueue, remove, update, promote, dequeue, peek };
}
