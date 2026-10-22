import { isEmptyChatTurnInput, type ChatModelTier } from "@alfred/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { StreamingMessage } from "./chat-stream-state";
import { useChatQueue, type QueuedEdit, type QueuedMessage } from "./use-chat-queue";
import type { SendMessage } from "./use-send-message";

/** A stopped turn writes its reply before its run ends, so the next send can meet `busy`. */
const QUEUE_BUSY_RETRY_MS = 1_000;

/** Then the head waits for the next completion. */
const QUEUE_BUSY_RETRIES = 5;

export interface QueueDispatchInput {
  threadId: string | undefined;
  tier: ChatModelTier;
  send: SendMessage;
  /** The turn on screen, from `useChatStream` + `shouldShowStream`. */
  turn: { onScreen: boolean; streaming: boolean; stream: StreamingMessage | null };
  /** A reply streams and no approval waits. */
  canSteer: boolean;
  /** Freeze the bubble and stop the run. */
  stopGeneration: () => void;
}

/** What the composer tray shows and the actions its rows call. */
interface QueueTrayModel {
  items: QueuedMessage[];
  /** The entry with a send in flight, at any position. */
  sendingId: string | null;
  /** The entry a steer stopped the reply for. Its row shows "Steering…". */
  steeringId: string | null;
  /** The entry open for an in-place edit. The flush waits while it is next. */
  editingId: string | null;
  /** Stop held the queue. It waits for Resume. */
  paused: boolean;
  remove: (id: string) => void;
  update: (id: string, patch: QueuedEdit) => void;
  sendNow: (id: string) => void;
  resume: () => void;
  setEditingId: (id: string | null) => void;
}

export interface QueueDispatch {
  /** Composer submit: send now, or queue behind the turn on screen and the waiting entries. */
  submit: (text: string, files?: File[], artifactTargetId?: string) => Promise<boolean>;
  /** Present only while a steer can run. */
  steer:
    | ((text: string, files?: File[], artifactTargetId?: string) => Promise<boolean>)
    | undefined;
  /** Message retry; a `busy` reply queues it with its attachment ids. */
  retry: (text: string, retryAttachmentIds?: string[], retryAttachmentMessageId?: string) => void;
  /** The Stop button: pause a non-empty queue, then stop. */
  stopReply: () => void;
  tray: QueueTrayModel;
}

/**
 * Per-thread client queue (#489): while a reply streams, submits queue as chips. On completion the
 * oldest sends, one at a time. A `busy` reply retries a few times, then waits. Each send claims its
 * entry until it settles, so a thread change or a reorder cannot start that entry again.
 */
export function useQueueDispatch({
  threadId,
  tier,
  send,
  turn,
  canSteer,
  stopGeneration,
}: QueueDispatchInput): QueueDispatch {
  const { queue, sendingId, enqueue, remove, update, promote, claim } = useChatQueue(threadId);
  const { onScreen: showStream, streaming: isStreaming, stream } = turn;
  // The queued message open for an in-place edit. The flush waits while it is next.
  const [editingQueuedId, setEditingQueuedId] = useState<string | null>(null);
  // The queued message a steer stopped the reply for. Its row shows "Steering…".
  const [steeringId, setSteeringId] = useState<string | null>(null);
  // Set by a completion; cleared once the head starts or fails for good.
  const [flushArmed, setFlushArmed] = useState(false);
  // Stop holds the queue, so the next message does not send over the reply you stopped.
  // Resume, or a row's send now, lets it go.
  const [queuePaused, setQueuePaused] = useState(false);
  const busyAttemptsRef = useRef(0);
  // A flush takes the next number when it starts. A thread change or an unmount moves it on, so an
  // in-flight flush whose number is old writes no flags after its await.
  const flushOwnerRef = useRef(0);
  const prevShowStreamRef = useRef(false);
  const lastErrorStreamIdRef = useRef<string | null>(null);
  // Reset during render so the old thread's `showStream` cannot flush the new thread's queue.
  // The send in flight is not reset: its claim belongs to its own thread until it settles.
  const [prevThreadId, setPrevThreadId] = useState(threadId);

  if (prevThreadId !== threadId) {
    setPrevThreadId(threadId);
    setFlushArmed(false);
    setQueuePaused(false);
    setEditingQueuedId(null);
    setSteeringId(null);
  }

  // The refs reset in an effect, because render may not write a ref. React runs the effects of
  // one commit in order, so this runs before the flush effects below see the new thread.
  useEffect(() => {
    prevShowStreamRef.current = false;
    lastErrorStreamIdRef.current = null;
    busyAttemptsRef.current = 0;

    // Not the flush effect's cleanup: that one re-runs when the flush claims an entry.
    return () => {
      flushOwnerRef.current += 1;
    };
  }, [threadId]);

  const submit = useCallback(
    async (text: string, files?: File[], artifactTargetId?: string): Promise<boolean> => {
      const trimmed = text.trim();
      const hasFiles = Boolean(files && files.length > 0);

      // So the composer does not clear on an empty submit.
      if (
        isEmptyChatTurnInput({
          content: trimmed,
          hasFiles,
          artifactTargetId,
        })
      )
        return false;

      // Queue while a turn is active, including done-but-not-synced, so no stream mounts over that bubble.
      // Queue behind waiting messages too, so a send never jumps ahead of them, paused or not.
      if (showStream || queue.length > 0) {
        const ok = enqueue({ text: trimmed, files: files ?? [], tier, artifactTargetId }) !== null;

        // No turn will complete to arm the flush, for example after a hard error kept the head.
        if (ok && !showStream && !queuePaused) setFlushArmed(true);

        return ok;
      }

      const result = await send(
        threadId,
        text,
        tier,
        files,
        undefined,
        undefined,
        artifactTargetId,
      );

      if (result.ok) return true;

      if (result.reason === "busy") {
        // Another turn is in flight (#488). Queue it; the flush retries until that run ends.
        const ok = enqueue({ text: trimmed, files: files ?? [], tier, artifactTargetId }) !== null;

        if (ok) setFlushArmed(true);

        return ok;
      }

      if (result.reason === "empty") return false;

      // `useSendMessage` already toasted. Keep the draft.
      return false;
    },
    [showStream, queue.length, queuePaused, enqueue, send, threadId, tier],
  );

  // On completion (stream done and synced), arm the flush of the oldest queued message.
  const streamDone = stream?.done ?? false;
  const streamError = stream?.error ?? null;
  const streamRunId = stream?.runId ?? null;
  useEffect(() => {
    const prev = prevShowStreamRef.current;
    prevShowStreamRef.current = showStream;
    const completed = prev && !showStream;

    // A done stream with an error and no durable message (SSE drop) counts as complete.
    // Arm once per `runId+error` to avoid a retry loop.
    const errorId =
      streamDone && streamError ? `${streamRunId ?? "unknown"}:${String(streamError)}` : null;

    const isNewErrorCompletion =
      Boolean(errorId) &&
      errorId !== lastErrorStreamIdRef.current &&
      queue.length > 0 &&
      !isStreaming;

    if (isNewErrorCompletion && errorId) lastErrorStreamIdRef.current = errorId;

    if (!streamDone || !streamError) lastErrorStreamIdRef.current = null;

    if ((completed || isNewErrorCompletion) && queue.length > 0) {
      // Each completion gives the head the full retry budget, also when a stream cut the last flush short.
      busyAttemptsRef.current = 0;
      setFlushArmed(true);
    }
  }, [showStream, queue.length, isStreaming, streamDone, streamError, streamRunId]);

  // An armed flush with nothing left to send disarms during render, so it cannot fire on a later enqueue.
  if (flushArmed && sendingId === null && !isStreaming && queue.length === 0) setFlushArmed(false);

  // An empty queue has nothing to hold.
  if (queuePaused && queue.length === 0) setQueuePaused(false);

  // Send the head while armed. The thread's claim stops a burst while the new stream mounts.
  // A pause keeps the arm, so Resume sends without a new completion.
  useEffect(() => {
    if (!flushArmed || queuePaused || sendingId !== null || isStreaming) return;
    const next = queue[0];

    if (!next) return;

    // Wait for the edit, so a half-edited message never sends. Saving or canceling re-runs this.
    if (next.id === editingQueuedId) return;

    // The claim commits with the start, so a second run cannot send twice and the row shows `sending`.
    const claimed = claim(next.id);

    if (!claimed) return;
    // Taken before the await, so a thread change or an unmount during the send moves past it.
    const owner = ++flushOwnerRef.current;
    const { entry } = claimed;
    void (async () => {
      // Every exit settles the claim exactly once, also an old owner's and a throw's.
      let outcome: "remove" | "keep" = "keep";

      try {
        const result = await send(
          threadId,
          entry.text,
          entry.tier,
          entry.files,
          entry.retryAttachmentIds,
          entry.retryAttachmentMessageId,
          entry.artifactTargetId,
        );

        // The claim is bound to this thread's queue, so a sent entry leaves it also after a thread
        // change. An `empty` entry is stale; drop it so it does not block the queue.
        if (result.ok || result.reason === "empty") outcome = "remove";

        // A thread change or an unmount took the flags; they belong to another owner now.
        if (owner !== flushOwnerRef.current) return;

        if (result.ok) {
          setFlushArmed(false);
          // The started turn's completion sends a steer added during the send, so its row keeps "Steering…".
          setSteeringId((prev) => (prev === entry.id ? null : prev));
          busyAttemptsRef.current = 0;
        } else if (result.reason === "busy" && busyAttemptsRef.current < QUEUE_BUSY_RETRIES) {
          // Stay armed and try again. The chip shows the entry, so no toast.
          busyAttemptsRef.current += 1;
          await new Promise((resolve) => setTimeout(resolve, QUEUE_BUSY_RETRY_MS));
        } else {
          // An `empty` entry, a hard error (already toasted), or a run that stays busy. A failed entry
          // waits for the next completion. No turn started, so nothing sends a steer; its row goes back to idle.
          setFlushArmed(false);
          setSteeringId(null);
          busyAttemptsRef.current = 0;
        }
      } finally {
        claimed.settle(outcome);
      }
    })();
  }, [
    flushArmed,
    queuePaused,
    queue,
    sendingId,
    isStreaming,
    editingQueuedId,
    send,
    threadId,
    claim,
  ]);

  // Retry sends the attachment ids, not files; the server copies the bytes (ADR-0065).
  const retry = useCallback(
    (text: string, retryAttachmentIds?: string[], retryAttachmentMessageId?: string) => {
      void (async () => {
        const result = await send(
          threadId,
          text,
          tier,
          undefined,
          retryAttachmentIds,
          retryAttachmentMessageId,
        );

        if (!result.ok && result.reason === "busy") {
          // On a collision, queue it with its attachment ids.
          enqueue({
            text,
            files: [],
            tier,
            artifactTargetId: undefined,
            retryAttachmentIds,
            retryAttachmentMessageId,
          });
        }
      })();
    },
    [send, threadId, tier, enqueue],
  );

  // The Stop button. A steer stops through `stopGeneration` and does not pause.
  const stopReply = useCallback(() => {
    if (queue.length > 0) setQueuePaused(true);
    stopGeneration();
  }, [queue.length, stopGeneration]);

  const resume = useCallback(() => {
    setQueuePaused(false);

    // The stopped turn may have completed already, so arm the head here.
    if (!showStream) setFlushArmed(true);
  }, [showStream]);

  // The stop finalizes the partial reply, so the next turn sees it. The queue sends the steer
  // on completion, ahead of older entries. An empty steer is rejected before the stop.
  const steer = useCallback(
    async (text: string, files?: File[], artifactTargetId?: string): Promise<boolean> => {
      if (!canSteer) return submit(text, files, artifactTargetId);

      const id = enqueue(
        { text: text.trim(), files: files ?? [], tier, artifactTargetId },
        "front",
      );

      if (!id) return false;
      setSteeringId(id);
      stopGeneration();

      return true;
    },
    [canSteer, submit, enqueue, tier, stopGeneration],
  );

  // "Send now" on a queued chip: the same steer for a message that already waits.
  const sendNow = useCallback(
    (id: string) => {
      // The entry in flight already sends; a steer for it would stop a reply it did not start.
      if (id === sendingId) return;
      promote(id);
      setQueuePaused(false);

      if (canSteer) {
        setSteeringId(id);
        stopGeneration();
      }
      // No turn on screen (a send that met `busy`): try the head now.
      else if (!showStream) setFlushArmed(true);
    },
    [sendingId, promote, canSteer, stopGeneration, showStream],
  );

  return {
    submit,
    steer: canSteer ? steer : undefined,
    retry,
    stopReply,
    tray: {
      items: queue,
      sendingId,
      steeringId,
      editingId: editingQueuedId,
      paused: queuePaused,
      remove,
      update,
      sendNow,
      resume,
      setEditingId: setEditingQueuedId,
    },
  };
}
