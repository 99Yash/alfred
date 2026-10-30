import { useCallback, useEffect, useSyncExternalStore } from "react";
import { authClient } from "~/lib/auth/auth-client";
import { frameThreadId, type EventStreamFrame } from "~/lib/events/frame";
import { openEventStream } from "~/lib/events/stream";
import { toast } from "~/lib/toast";
import {
  applyChatFrame,
  applyChatSeed,
  applyOptimisticStop,
  applyStreamError,
  createChatStreamCell,
  settleDrip,
  streamSnapshotsEqual,
  tickDrip,
  type ChatStreamCell,
  type StreamingMessage,
} from "./chat-stream-state";

export interface ChatStream {
  stream: StreamingMessage | null;
  /** Freeze the UI now. The caller still sends the server stop request. */
  stopStream: () => void;
}

/** A dead bus with no terminal frame would leave the stop button up forever. */
const WATCHDOG_MS = 45_000;

const STREAM_ERROR_MESSAGE = "Live updates disconnected. The reply may be incomplete.";

const WATCHDOG_ERROR_MESSAGE =
  "Connection stalled. No updates received. The reply may be incomplete.";

/**
 * One thread's live turn. It outlives the thread page: the shared event bus does not
 * send a frame again to a later subscriber, so a page that built its own state on mount
 * lost every frame from before the user came back.
 */
interface ThreadStream {
  cell: ChatStreamCell;
  /** The last projection. Stable between frames, so `useSyncExternalStore` reads it as is. */
  snapshot: StreamingMessage | null;
  listeners: Set<() => void>;
  raf: number | null;
}

const threads = new Map<string, ThreadStream>();

let watchdogId: number | null = null;

function threadStream(threadId: string): ThreadStream {
  const existing = threads.get(threadId);

  if (existing) return existing;

  const created: ThreadStream = {
    cell: createChatStreamCell(threadId),
    snapshot: null,
    listeners: new Set(),
    raf: null,
  };

  threads.set(threadId, created);

  return created;
}

/** Store a projection. Returns whether it changed. */
function storeProjection(entry: ThreadStream, next: StreamingMessage | null): boolean {
  if (next === null ? entry.snapshot === null : streamSnapshotsEqual(entry.snapshot, next)) {
    return false;
  }

  entry.snapshot = next;

  return true;
}

/**
 * Re-project after a state change. A watched thread eases its text in on animation frames.
 * An unwatched thread projects everything now, so a return shows the full trail at once.
 */
function scheduleProjection(entry: ThreadStream): void {
  if (entry.listeners.size === 0) {
    settleDrip(entry.cell);
    storeProjection(entry, tickDrip(entry.cell)?.snapshot ?? null);

    return;
  }

  if (entry.raf !== null) return;

  const tick = () => {
    entry.raf = null;
    const projected = tickDrip(entry.cell);
    const changed = storeProjection(entry, projected?.snapshot ?? null);

    if (changed) for (const listener of entry.listeners) listener();

    // Park once caught up; the next frame restarts the loop.
    if (projected && !projected.caughtUp) entry.raf = requestAnimationFrame(tick);
  };

  entry.raf = requestAnimationFrame(tick);
}

/** Drop a thread nobody watches once its turn is over. A synced message replaces a finished turn. */
function releaseIfSettled(threadId: string, entry: ThreadStream): void {
  if (entry.listeners.size > 0 || threads.get(threadId) !== entry) return;
  const current = entry.cell.current;

  if (current !== null && !current.done) return;

  if (entry.raf !== null) cancelAnimationFrame(entry.raf);
  threads.delete(threadId);
}

/** Any frame proves the bus is alive, so each one moves the deadline for every live turn. */
function armWatchdog(): void {
  if (watchdogId !== null) {
    clearTimeout(watchdogId);
    watchdogId = null;
  }

  // A run parked on an approval is silent by design (ADR-0099). The next frame re-arms.
  const live = [...threads.values()].some(({ cell }) => {
    const cur = cell.current;

    return cur !== null && !cur.done && !cur.awaitingApproval;
  });

  if (!live) return;
  watchdogId = window.setTimeout(() => {
    watchdogId = null;
    let stalled = false;

    for (const entry of threads.values()) {
      if (entry.cell.current?.awaitingApproval) continue;

      if (applyStreamError(entry.cell, WATCHDOG_ERROR_MESSAGE)) {
        stalled = true;
        scheduleProjection(entry);
      }
    }

    if (stalled) toast.error("Connection stalled. Live updates stopped. Please retry.");
  }, WATCHDOG_MS);
}

/** Kinds that can mount a turn. Others only address a turn that is already there. */
function mountsTurn(frame: EventStreamFrame): boolean {
  switch (frame.kind) {
    case "chat.message":
    case "chat.delta":
    case "chat.reasoning":
    case "chat.tool":
      return true;
    case "agent.progress":
    case "agent.run":
    case "approval.requested":
    case "artifact.delta":
    case "inbox.updated":
    case "memory.fact_learned":
    case "tool.call":
      return false;
    default: {
      const _exhaustive: never = frame;

      return _exhaustive;
    }
  }
}

function onFrame(frame: EventStreamFrame): void {
  const named = frameThreadId(frame);
  let targets: [string, ThreadStream][];

  if (named === null) {
    targets = [...threads];
  } else {
    const entry = mountsTurn(frame) ? threadStream(named) : threads.get(named);
    targets = entry ? [[named, entry]] : [];
  }

  const now = Date.now();

  for (const [threadId, entry] of targets) {
    if (applyChatFrame(entry.cell, frame, now)) scheduleProjection(entry);
    releaseIfSettled(threadId, entry);
  }

  armWatchdog();
}

function onBusError(): void {
  let failed = false;

  for (const entry of threads.values()) {
    if (applyStreamError(entry.cell, STREAM_ERROR_MESSAGE)) {
      failed = true;
      scheduleProjection(entry);
    }
  }

  armWatchdog();

  if (failed) toast.error(`${STREAM_ERROR_MESSAGE} Please retry.`);
}

/**
 * Keep every thread's live turn current while the app runs. Mount once, in the app shell,
 * so a turn keeps its frames while the user is on another page.
 */
export function useChatStreamStore(): void {
  const { data: session } = authClient.useSession();
  const userId = session?.user.id;

  useEffect(() => {
    if (!userId) return;
    const close = openEventStream({ onFrame, onError: onBusError });

    return () => {
      close();

      if (watchdogId !== null) {
        clearTimeout(watchdogId);
        watchdogId = null;
      }

      for (const entry of threads.values()) {
        if (entry.raf !== null) cancelAnimationFrame(entry.raf);
      }

      // Another user's turns must not show after a sign-in change.
      threads.clear();
    };
  }, [userId]);
}

/**
 * Show a started turn from the send ack. Without it, the bubble, Stop, and the queue wait
 * for the worker's "started" frame, and a new chat never sees that frame.
 */
export function seedChatStream(threadId: string, turn: { messageId: string; runId: string }) {
  const entry = threadStream(threadId);

  if (!applyChatSeed(entry.cell, { ...turn, at: Date.now() })) return;
  scheduleProjection(entry);
  armWatchdog();
}

function subscribeThread(threadId: string, listener: () => void): () => void {
  const entry = threadStream(threadId);
  entry.listeners.add(listener);

  return () => {
    entry.listeners.delete(listener);

    if (entry.listeners.size > 0) return;

    if (entry.raf !== null) {
      cancelAnimationFrame(entry.raf);
      entry.raf = null;
    }

    // The next view of this thread starts from everything received.
    scheduleProjection(entry);
    // StrictMode subscribes again in the same commit, so wait one microtask before a release.
    queueMicrotask(() => releaseIfSettled(threadId, entry));
  };
}

/**
 * The in-flight turn for `threadId`, eased into smooth typing. The state machine is
 * in `chat-stream-state.ts`; `useChatStreamStore` feeds it frames for every thread.
 * The synced message with the same id replaces this bubble.
 */
export function useChatStream(threadId: string | undefined): ChatStream {
  const subscribe = useCallback(
    (listener: () => void) => (threadId ? subscribeThread(threadId, listener) : () => {}),
    [threadId],
  );

  const getSnapshot = useCallback(
    () => (threadId ? (threads.get(threadId)?.snapshot ?? null) : null),
    [threadId],
  );

  const stream = useSyncExternalStore(subscribe, getSnapshot, () => null);

  const stopStream = useCallback(() => {
    const entry = threadId ? threads.get(threadId) : undefined;

    if (!entry || !applyOptimisticStop(entry.cell)) return;
    scheduleProjection(entry);
    armWatchdog();
  }, [threadId]);

  return { stream, stopStream };
}
