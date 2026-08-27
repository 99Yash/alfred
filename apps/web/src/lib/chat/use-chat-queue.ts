import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatModelTier } from "@alfred/contracts";

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
}

type Queues = Record<string, QueuedMessage[]>;

function queueKey(threadId: string | undefined): string {
  return threadId ?? "__new__";
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
 * Implementation is a plain in-memory `Record<threadId, QueuedMessage[]>`
 * in component state — no persistence for v1 — so reload clears it. The map
 * keeps each thread's slice isolated; `queueKey` scopes `__new__` for the
 * bare `/chat` surface so that surface does not leak a queue into a real thread.
 */
export function useChatQueue(threadId: string | undefined): ChatQueue {
  const [queues, setQueues] = useState<Queues>({});
  const key = queueKey(threadId);
  const queue = useMemo(() => queues[key] ?? [], [queues, key]);

  // Migrate any queued entries from the ephemeral `__new__` bucket (the bare
  // `/chat` surface) into the newly created real thread after the first send
  // navigates to `/chat/$threadId`. Without this, a message queued while the
  // first turn was still mounting before navigation would stay stranded under
  // `__new__` and disappear after the route change.
  useEffect(() => {
    if (!threadId) return;
    setQueues((prev) => {
      const oldKey = "__new__";
      const oldQueue = prev[oldKey];
      if (!oldQueue || oldQueue.length === 0) return prev;
      const newQueue = prev[threadId];
      if (newQueue && newQueue.length > 0) return prev;
      const next = { ...prev } satisfies Queues;
      next[threadId] = oldQueue;
      next[oldKey] = [];
      return next;
    });
  }, [threadId]);

  const enqueue = useCallback(
    (entry: Omit<QueuedMessage, "id">): boolean => {
      const text = entry.text.trim();
      const hasFiles = entry.files.length > 0;
      const hasArtifact = Boolean(entry.artifactTargetId);
      // Empty/whitespace-only entries are not enqueued; an image-only entry
      // (empty text + files) is valid and must be kept. Mirrors the send guard
      // in `useSendMessage` so the two gates cannot disagree on what counts as
      // "nothing to send".
      if (text.length === 0 && !hasFiles && !hasArtifact) return false;
      // Normalize to trimmed text so a chip never renders leading/trailing blank
      // and the started turn does not carry it.
      const normalized = text.length === 0 && !hasFiles ? "" : text;
      // Guard duplicated here: a whitespace-only text with no files must not
      // enqueue even if the caller forgot to trim before calling.
      if (normalized.length === 0 && !hasFiles) return false;
      const id = crypto.randomUUID();
      const queued: QueuedMessage = {
        id,
        text: normalized,
        files: entry.files,
        tier: entry.tier,
        artifactTargetId: entry.artifactTargetId,
      };
      setQueues((prev) => {
        const prevList = prev[key] ?? [];
        return { ...prev, [key]: [...prevList, queued] };
      });
      return true;
    },
    [key],
  );

  const remove = useCallback(
    (id: string) => {
      setQueues((prev) => {
        const list = prev[key] ?? [];
        const next = list.filter((m) => m.id !== id);
        if (next.length === list.length) return prev;
        return { ...prev, [key]: next };
      });
    },
    [key],
  );

  const dequeue = useCallback(() => {
    setQueues((prev) => {
      const list = prev[key] ?? [];
      if (list.length === 0) return prev;
      return { ...prev, [key]: list.slice(1) };
    });
  }, [key]);

  const peek = useCallback(() => queue[0], [queue]);

  return { queue, enqueue, remove, dequeue, peek };
}
