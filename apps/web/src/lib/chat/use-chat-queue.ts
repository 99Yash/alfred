import { useCallback, useMemo, useRef, useState } from "react";
import {
  isEmptyChatTurnInput,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_QUEUED_TURNS,
  type ChatModelTier,
} from "@alfred/contracts";
import { toast } from "~/lib/toast";
import { safeRandomId } from "./safe-random-id";

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

/** `remove`: the turn started, or the entry was stale (`empty`). `keep`: it waits for a later flush. */
type SendOutcome = "remove" | "keep";

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
   * Hold this thread for one send of an entry, run `send`, and release the hold when it settles.
   * `false` when this thread already has a send in flight or the entry is gone from the rendered
   * queue. Two checks cover the two edges of a hold: a private ref covers the start, before the hold
   * renders, and the rendered `sendingId` covers the release, because the release clears it and drops
   * a sent entry in one write. `send` starts before `run` returns. Its outcome lands on this thread
   * also after a thread change. A `remove` outcome drops the entry by id, so the caller must not run
   * an entry that has an edit open.
   */
  run: (id: string, send: (entry: QueuedMessage) => Promise<SendOutcome>) => boolean;
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
  // The threads with a send in flight. `run` reads it synchronously, so two runs in one tick cannot both start.
  const heldRef = useRef(new Set<string>());

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

      const id = safeRandomId("q");

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

  const run = useCallback(
    (id: string, send: (entry: QueuedMessage) => Promise<SendOutcome>): boolean => {
      const rendered = queues.get(key);
      const entry = rendered?.entries.find((m) => m.id === id);

      // The ref answers now, before the hold renders. Rendered state lags a commit, and a state updater
      // cannot refuse the caller. The rendered `sendingId` stays set until the release renders, so a
      // run from that render cannot send the released entry again.
      if (!rendered || !entry || heldRef.current.has(key) || rendered.sendingId !== null)
        return false;
      heldRef.current.add(key);
      // The hold always records, also when a remove landed first, so the thread starts no second send.
      setQueues((prev) => {
        const thread = prev.get(key) ?? { entries: NO_ENTRIES, sendingId: null };

        return withThread(prev, key, { ...thread, sendingId: id });
      });

      // `key` is the hold's thread, not the one on screen when the send ends.
      const release = (outcome: SendOutcome) => {
        heldRef.current.delete(key);
        setQueues((prev) => {
          const thread = prev.get(key);

          if (!thread) return prev;

          return withThread(prev, key, {
            entries:
              outcome === "remove" ? thread.entries.filter((m) => m.id !== id) : thread.entries,
            sendingId: thread.sendingId === id ? null : thread.sendingId,
          });
        });
      };

      // Every exit releases the hold exactly once, also a throw.
      void (async () => {
        let outcome: SendOutcome = "keep";

        try {
          outcome = await send(entry);
        } finally {
          release(outcome);
        }
      })();

      return true;
    },
    [key, queues],
  );

  return { queue, sendingId, enqueue, remove, update, promote, run };
}
