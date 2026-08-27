import { useCallback, useEffect, useMemo, useState } from "react";
import {
  isEmptyChatTurnInput,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_QUEUED_TURNS,
  type ChatModelTier,
} from "@alfred/contracts";

/**
 * One message waiting for the in-flight turn to finish before it is started as
 * its own turn. FIFO, client-local, per-thread — does not survive reload (v1).
 * The queue lives in an in-memory map keyed by threadId so switching threads
 * does not leak queued text into the wrong conversation; the thread-scoped
 * slice is what the composer renders as removable chips (#489).
 */
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
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface ChatQueue {
  /** FIFO slice for the current thread — render as chips above the composer. */
  queue: QueuedMessage[];
  /** Enqueue after trimming; returns false when the entry is empty and was not added. */
  enqueue: (entry: Omit<QueuedMessage, "id">) => boolean;
  /** Remove a pending chip before it sends; order of the rest is preserved. */
  remove: (id: string) => void;
  /** Drop the oldest entry after it has been successfully started. */
  dequeue: () => void;
  /** Peek at the oldest entry without removing it. */
  peek: () => QueuedMessage | undefined;
}

/**
 * Per-thread client-local message queue for the chat composer (#489).
 *
 * While a turn is streaming, submits are enqueued instead of dropped. When the
 * current turn completes (stream done + durable synced), the oldest entry is
 * started as its own turn. The `busy` guard (#488) keeps the entry queued for a
 * retry rather than dropping it or duplicating the run.
 *
 * Implementation is an in-memory `Map<threadId, QueuedMessage[]>` in component
 * state — no persistence for v1 — so reload clears it. The map keeps each
 * thread's slice isolated; `queueKey` scopes `__new__` for the bare `/chat`
 * surface so that surface does not leak a queue into a real thread.
 */
export function useChatQueue(threadId: string | undefined): ChatQueue {
  const [queues, setQueues] = useState<Queues>(() => new Map());
  const key = queueKey(threadId);
  const queue = useMemo(() => queues.get(key) ?? [], [queues, key]);

  // Migrate any queued entries from the ephemeral `__new__` bucket (the bare
  // `/chat` surface) into the newly created real thread after the first send
  // navigates to `/chat/$threadId`. Without this, a message queued while the
  // first turn was still mounting before navigation would stay stranded under
  // `__new__` and disappear after the route change.
  useEffect(() => {
    if (!threadId) return;
    setQueues((prev) => {
      const oldKey = "__new__";
      const oldQueue = prev.get(oldKey);
      if (!oldQueue || oldQueue.length === 0) return prev;
      const newQueue = prev.get(threadId) ?? [];
      // Merge rather than drop: if the new thread already has queued items
      // (race of two rapid enqueues around navigation), preserve FIFO by
      // appending the migrated items after the existing ones. Dropping either
      // side would silently lose the user's draft — the harsher structural
      // review flagged the old `if (newQueue.length>0) return prev` as data loss.
      const merged = [...newQueue, ...oldQueue];
      if (merged.length === 0) return prev;
      const next = new Map(prev);
      next.set(threadId, merged);
      next.set(oldKey, []);
      // Prune empty buckets to bound memory: a Map that grows per visited
      // thread would leak `File` handles. Delete empties and cap distinct
      // thread buckets (LRU-ish: drop oldest empty-ish entries if we exceed 20).
      if (next.get(oldKey)?.length === 0) next.delete(oldKey);
      if (next.size > 20) {
        const firstKey = next.keys().next().value as string | undefined;
        if (firstKey && firstKey !== threadId && firstKey !== oldKey) next.delete(firstKey);
      }
      return next;
    });
  }, [threadId]);

  const enqueue = useCallback(
    (entry: Omit<QueuedMessage, "id">): boolean => {
      const text = entry.text.trim();
      const hasFiles = entry.files.length > 0;
      // Single source of truth for "empty" — mirrors `useSendMessage` and
      // `ChatShell.onSend` via `isEmptyChatTurnInput` in `@alfred/contracts`.
      if (
        isEmptyChatTurnInput({
          content: text,
          hasFiles,
          artifactTargetId: entry.artifactTargetId,
          retryAttachmentIds: entry.retryAttachmentIds,
        })
      )
        return false;
      // Guard `File` caps at enqueue time so a queued batch cannot later exceed
      // the per-message limits the server enforces. The composer already caps
      // live attachments, but a queued turn bypasses that gate.
      if (entry.files.length > MAX_ATTACHMENTS_PER_MESSAGE) return false;
      // Normalize to trimmed text so a chip never renders leading/trailing blank
      // and the started turn does not carry it.
      const normalized = text;
      if (
        isEmptyChatTurnInput({
          content: normalized,
          hasFiles,
          artifactTargetId: entry.artifactTargetId,
          retryAttachmentIds: entry.retryAttachmentIds,
        })
      )
        return false;

      // Capacity: keep queue bounded so a runaway loop cannot pin unbounded
      // `File` handles in memory. When full, reject and let the caller keep
      // the draft in the composer (same as "empty" → composer does not clear).
      const currentLen = queues.get(key)?.length ?? 0;
      if (currentLen >= MAX_QUEUED_TURNS) return false;

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
        next.set(key, [...prevList, queued]);
        return next;
      });
      return true;
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

  return { queue, enqueue, remove, dequeue, peek };
}
