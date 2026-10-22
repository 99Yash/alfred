import { useCallback, useMemo, useState } from "react";
import {
  isEmptyChatTurnInput,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_QUEUED_TURNS,
  type ChatModelTier,
} from "@alfred/contracts";
import { toast } from "~/lib/toast";

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

/** The part of a queued message that an edit can change. */
export type QueuedEdit = Pick<QueuedMessage, "text" | "files">;

interface ThreadQueue {
  entries: QueuedMessage[];
  /** The entry with a send in flight. It holds the thread's one send until the send settles. */
  sendingId: string | null;
}

type Queues = Map<string, ThreadQueue>;

const NO_ENTRIES: QueuedMessage[] = [];

/** Write one thread back. A thread with no entries and no send in flight leaves the map. */
function withThread(prev: Queues, key: string, next: ThreadQueue): Queues {
  const map = new Map(prev);

  if (next.entries.length === 0 && next.sendingId === null) map.delete(key);
  else map.set(key, next);

  return map;
}

function queueKey(threadId: string | undefined): string {
  return threadId ?? "__new__";
}

function safeRandomId(): string {
  // lib.dom types `randomUUID` as always present; browsers expose it only in secure contexts.
  if (typeof crypto === "undefined" || !("randomUUID" in crypto))
    return `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return crypto.randomUUID();
}

/** The in-flight send of one entry, bound to its thread queue. Settle it exactly once. */
interface QueueClaim {
  entry: QueuedMessage;
  /** `remove`: the turn started, or the entry was stale (`empty`). `keep`: it waits for a later flush. */
  settle: (outcome: "remove" | "keep") => void;
}

export interface ChatQueue {
  /** This thread's FIFO, shown as chips above the composer. */
  queue: QueuedMessage[];
  /** This thread's entry with a send in flight. It stays set across thread changes until the send settles. */
  sendingId: string | null;
  /**
   * The new entry's id, or `null` when the entry is empty, over a cap, or the queue is full.
   * `front` puts a steer (#490) ahead of the waiting entries.
   */
  enqueue: (entry: Omit<QueuedMessage, "id">, position?: "back" | "front") => string | null;
  /** Drop an entry by id. Refuses the entry with a send in flight. */
  remove: (id: string) => void;
  /**
   * Replace an entry's text and files. An edit that leaves nothing to send removes the entry.
   * Refuses the entry with a send in flight.
   */
  update: (id: string, patch: QueuedEdit) => void;
  /** Move an entry to the head, so it sends next. */
  promote: (id: string) => void;
  /**
   * Claim an entry for a send. `null` when this thread already has a send in flight or the entry
   * is gone. The settle is bound to this thread, so it lands here also after a thread change.
   */
  claim: (id: string) => QueueClaim | null;
}

/**
 * Per-thread composer queue. Sends during a turn wait here and start when it ends.
 * A reload clears it. The bare `/chat` page uses the `__new__` key.
 */
export function useChatQueue(threadId: string | undefined): ChatQueue {
  const [queues, setQueues] = useState<Queues>(() => new Map());
  const key = queueKey(threadId);
  const queue = useMemo(() => queues.get(key)?.entries ?? NO_ENTRIES, [queues, key]);
  const sendingId = queues.get(key)?.sendingId ?? null;

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
      const currentLen = queues.get(key)?.entries.length ?? 0;

      if (currentLen >= MAX_QUEUED_TURNS) {
        toast.error(`Only ${MAX_QUEUED_TURNS} messages can wait. Remove one or wait for a reply.`);

        return null;
      }

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
        const thread = prev.get(key) ?? { entries: NO_ENTRIES, sendingId: null };
        const prevList = thread.entries;

        if (prevList.length >= MAX_QUEUED_TURNS) return prev;

        return withThread(prev, key, {
          ...thread,
          entries: position === "front" ? [queued, ...prevList] : [...prevList, queued],
        });
      });

      return id;
    },
    [key, queues],
  );

  const remove = useCallback(
    (id: string) => {
      setQueues((prev) => {
        const thread = prev.get(key);

        if (!thread || thread.sendingId === id) return prev;
        const next = thread.entries.filter((m) => m.id !== id);

        if (next.length === thread.entries.length) return prev;

        return withThread(prev, key, { ...thread, entries: next });
      });
    },
    [key],
  );

  const update = useCallback(
    (id: string, { text, files }: QueuedEdit) => {
      setQueues((prev) => {
        const thread = prev.get(key);

        if (!thread || thread.sendingId === id) return prev;
        const list = thread.entries;
        const entry = list.find((m) => m.id === id);

        if (!entry) return prev;

        // The same "empty" rule as `enqueue`, so an emptied entry cannot block the flush.
        const empty = isEmptyChatTurnInput({
          content: text.trim(),
          hasFiles: files.length > 0,
          artifactTargetId: entry.artifactTargetId,
          retryAttachmentIds: entry.retryAttachmentIds,
        });

        const next = empty
          ? list.filter((m) => m !== entry)
          : list.map((m) => (m === entry ? { ...m, text: text.trim(), files } : m));

        return withThread(prev, key, { ...thread, entries: next });
      });
    },
    [key],
  );

  const promote = useCallback(
    (id: string) => {
      setQueues((prev) => {
        const thread = prev.get(key);
        const list = thread?.entries ?? NO_ENTRIES;
        const entry = list.find((m) => m.id === id);

        if (!thread || !entry || list[0] === entry) return prev;

        return withThread(prev, key, {
          ...thread,
          entries: [entry, ...list.filter((m) => m !== entry)],
        });
      });
    },
    [key],
  );

  const claim = useCallback(
    (id: string): QueueClaim | null => {
      // The rendered state gives the answer now; the updater checks again against the latest state.
      const thread = queues.get(key);
      const entry = thread?.entries.find((m) => m.id === id);

      if (!thread || !entry || thread.sendingId !== null) return null;

      setQueues((prev) => {
        const latest = prev.get(key);

        if (!latest || latest.sendingId !== null || !latest.entries.some((m) => m.id === id))
          return prev;

        return withThread(prev, key, { ...latest, sendingId: id });
      });

      let settled = false;

      return {
        entry,
        settle: (outcome) => {
          if (settled) return;
          settled = true;

          // `key` is the claim's thread, not the one on screen when the send ends.
          setQueues((prev) => {
            const latest = prev.get(key);

            if (!latest) return prev;

            return withThread(prev, key, {
              entries:
                outcome === "remove" ? latest.entries.filter((m) => m.id !== id) : latest.entries,
              sendingId: latest.sendingId === id ? null : latest.sendingId,
            });
          });
        },
      };
    },
    [key, queues],
  );

  return { queue, sendingId, enqueue, remove, update, promote, claim };
}
