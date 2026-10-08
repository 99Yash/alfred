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
  stream: StreamingMessage | null;
  /** Freeze the UI now. The caller still sends the server stop request. */
  stopStream: () => void;
}

interface StreamSnapshot {
  threadId: string;
  message: StreamingMessage;
}

/** A dead bus with no terminal frame would leave the stop button up forever. */
const WATCHDOG_MS = 45_000;

const STREAM_ERROR_MESSAGE = "Live updates disconnected — reply may be incomplete.";

const WATCHDOG_ERROR_MESSAGE =
  "Connection stalled — no updates received. The reply may be incomplete.";

/**
 * The in-flight turn for `threadId`, eased into smooth typing. The state machine is
 * in `chat-stream-state.ts`; this hook runs the subscription and the rAF loop.
 * The synced message with the same id replaces this bubble.
 */
export function useChatStream(threadId: string | undefined): ChatStream {
  const [snapshot, setSnapshot] = useState<StreamSnapshot | null>(null);
  const rafRef = useRef<number | null>(null);
  // A stable proxy; the effect installs the real stopper.
  const stopFnRef = useRef<(() => void) | null>(null);
  const stopStream = useCallback(() => stopFnRef.current?.(), []);

  useEffect(() => {
    if (!threadId) return;

    // Per subscription, so no turn or snapshot crosses a thread change.
    const cell = createChatStreamCell(threadId);
    let lastSnapshot: StreamingMessage | null = null;

    let watchdogId: number | null = null;

    const clearWatchdog = () => {
      if (watchdogId !== null) {
        clearTimeout(watchdogId);
        watchdogId = null;
      }
    };

    const armWatchdog = () => {
      clearWatchdog();
      const cur = cell.current;

      if (!cur || cur.done) return;

      // A run parked on an approval is silent by design (ADR-0099). The next frame re-arms.
      if (cur.awaitingApproval) return;
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

        // Park once caught up; the next frame restarts the loop.
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

        // Any frame, even a dropped one, proves the bus is alive.
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
