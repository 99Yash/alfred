import { useCallback, useEffect, useRef, useState } from "react";
import { openEventStream } from "~/lib/events/stream";
import {
  applyChatFrame,
  applyOptimisticStop,
  createChatStreamCell,
  streamSnapshotsEqual,
  tickDrip,
  type StreamingMessage,
} from "./chat-stream-state";

export interface ChatStream {
  /** The in-flight assistant turn, or null when nothing is streaming. */
  stream: StreamingMessage | null;
  /**
   * Optimistically stop the in-flight turn: freeze the partial reply at what's
   * shown and flip the composer back to its idle state right away. Pair with
   * the server-side stop request — this just makes the UI instant.
   */
  stopStream: () => void;
}

interface StreamSnapshot {
  threadId: string;
  message: StreamingMessage;
}

/**
 * Assembles the in-flight assistant turn for `threadId` from the SSE event bus.
 * `chat.delta` text and `chat.reasoning` thinking are each buffered and eased
 * out a few chars per animation frame (the drip buffer) so bursty server
 * flushes render as smooth typing; `chat.tool` events become live cards;
 * `approval.requested` flips the awaiting-approval flag. Returns null when
 * nothing is streaming.
 *
 * The turn state machine itself lives in `chat-stream-state.ts` — this hook is
 * the subscription and the animation-frame scheduler around it. `applyChatFrame`
 * returning `true` is what schedules a frame; the loop parks itself once the
 * eased buffers have caught up, so an approval wait does not spin at 60fps.
 *
 * The streamed message is ephemeral — once the durable copy syncs via
 * Replicache (same messageId), the conversation view drops this bubble.
 */
export function useChatStream(threadId: string | undefined): ChatStream {
  const [snapshot, setSnapshot] = useState<StreamSnapshot | null>(null);
  const lastSnapshotRef = useRef<StreamingMessage | null>(null);
  const rafRef = useRef<number | null>(null);
  // The effect installs the real stopper once the SSE stream is open; the
  // returned `stopStream` is a stable proxy so consumers don't re-bind.
  const stopFnRef = useRef<(() => void) | null>(null);
  const stopStream = useCallback(() => stopFnRef.current?.(), []);

  useEffect(() => {
    lastSnapshotRef.current = null;
    if (!threadId) return;

    // One cell per subscription, so the turn state cannot outlive the thread it
    // belongs to: carrying a previous thread's turn across a `threadId` change
    // is unrepresentable rather than undone by a reset statement.
    const cell = createChatStreamCell(threadId);

    const ensureRaf = () => {
      if (rafRef.current !== null) return;
      const tick = () => {
        const projected = tickDrip(cell);
        if (!projected) {
          rafRef.current = null;
          return;
        }
        const { snapshot: next, caughtUp } = projected;
        if (!streamSnapshotsEqual(lastSnapshotRef.current, next)) {
          lastSnapshotRef.current = next;
          setSnapshot({ threadId, message: next });
        }
        // Keep ticking only while the eased buffers are catching up. Future
        // SSE frames call `ensureRaf()` again, including approval/completed
        // state changes.
        rafRef.current = caughtUp ? null : requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    };

    stopFnRef.current = () => {
      if (applyOptimisticStop(cell)) ensureRaf();
    };

    const close = openEventStream({
      onFrame: (frame) => {
        if (applyChatFrame(cell, frame, Date.now())) ensureRaf();
      },
    });
    return () => {
      close();
      stopFnRef.current = null;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [threadId]);

  const stream = snapshot && snapshot.threadId === threadId ? snapshot.message : null;
  return { stream, stopStream };
}
