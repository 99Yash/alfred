import { useCallback, useEffect, useRef, useState } from "react";
import { openEventStream } from "~/lib/events/stream";
import { toast } from "~/lib/toast";
import {
  applyChatFrame,
  applyOptimisticStop,
  applyStreamError,
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
 * Watchdog: if the SSE bus dies but the server never sends a terminal frame,
 * the bubble would hang on the stop button forever. 45s is deliberately
 * shorter than the 60s streaming timeout on the server (`code-style.md:backend`
 * — streaming ~60s) but well beyond the ~5/sec delta cadence, so a healthy
 * turn never trips it while a dead bus recovers before the user perceives a
 * hang. Centralized here (not per-component) so only one timer exists per
 * subscription; a third terminal reason would not re-invent it.
 */
const WATCHDOG_MS = 45_000;

const STREAM_ERROR_MESSAGE = "Live updates disconnected — reply may be incomplete.";
const WATCHDOG_ERROR_MESSAGE =
  "Connection stalled — no updates received. The reply may be incomplete.";

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
  const rafRef = useRef<number | null>(null);
  // The effect installs the real stopper once the SSE stream is open; the
  // returned `stopStream` is a stable proxy so consumers don't re-bind.
  const stopFnRef = useRef<(() => void) | null>(null);
  const stopStream = useCallback(() => stopFnRef.current?.(), []);

  useEffect(() => {
    if (!threadId) return;

    // One cell per subscription, so the turn state cannot outlive the thread it
    // belongs to: carrying a previous thread's turn across a `threadId` change
    // is unrepresentable rather than undone by a reset statement.
    const cell = createChatStreamCell(threadId);
    // The dedup baseline gets that same lifetime for the same reason: a fresh
    // binding per subscription cannot hold a previous thread's snapshot, so
    // nothing has to remember to clear it. Read and written only in `tick`.
    let lastSnapshot: StreamingMessage | null = null;

    let watchdogId: number | null = null;
    const clearWatchdog = () => {
      if (watchdogId !== null) {
        // `window.setTimeout` returns `number` in lib.dom; `clearTimeout` is global.
        clearTimeout(watchdogId);
        watchdogId = null;
      }
    };
    const armWatchdog = () => {
      clearWatchdog();
      const cur = cell.current;
      if (!cur || cur.done) return;
      watchdogId = window.setTimeout(() => {
        watchdogId = null;
        if (applyStreamError(cell, WATCHDOG_ERROR_MESSAGE)) {
          ensureRaf();
          toast.error("Connection stalled — live updates stopped. Please retry.");
        }
      }, WATCHDOG_MS);
    };

    const ensureRaf = () => {
      if (rafRef.current !== null) return;
      const tick = () => {
        const projected = tickDrip(cell);
        if (!projected) {
          rafRef.current = null;
          return;
        }
        const { snapshot: next, caughtUp } = projected;
        if (!streamSnapshotsEqual(lastSnapshot, next)) {
          lastSnapshot = next;
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
      clearWatchdog();
      if (applyOptimisticStop(cell)) ensureRaf();
    };

    const close = openEventStream({
      onFrame: (frame) => {
        const didChange = applyChatFrame(cell, frame, Date.now());
        if (didChange) ensureRaf();
        // Connection is alive — re-arm watchdog for any in-flight turn, not only
        // when the frame mutated the snapshot. A dup seq or a foreign-thread
        // frame (didChange=false) still proves the bus is healthy; only a done
        // turn or no turn should leave the timer cleared.
        if (cell.current?.done) clearWatchdog();
        else if (cell.current) armWatchdog();
      },
      onError: () => {
        clearWatchdog();
        if (applyStreamError(cell, STREAM_ERROR_MESSAGE)) {
          ensureRaf();
          toast.error(`${STREAM_ERROR_MESSAGE} Please retry.`);
        }
      },
    });
    return () => {
      close();
      clearWatchdog();
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
