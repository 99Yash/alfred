import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { Replicache } from "replicache";
import { SYNC_MODEL, type ClientMutators } from "@alfred/sync";
import { authClient } from "~/lib/auth/auth-client";
import { frameThreadId, type EventStreamFrame } from "~/lib/events/frame";
import { openEventStream, reconnectEventStream } from "~/lib/events/stream";
import { useReplicache } from "~/lib/replicache/context";
import {
  applyChatFrame,
  applyChatSeed,
  applyOptimisticStop,
  applySyncedClose,
  createChatStreamCell,
  settleDrip,
  streamSnapshotsEqual,
  tickDrip,
  type ChatStreamCell,
  type StreamingMessage,
} from "./chat-stream-state";
import { assertNever, toMessage } from "@alfred/contracts";

export interface ChatStream {
  stream: StreamingMessage | null;
  /** Freeze the UI now. The caller still sends the server stop request. */
  stopStream: () => void;
}

/**
 * No frame for a live turn in this time starts a recovery. The server heartbeat is an SSE
 * comment, which `EventSource` does not show, so silence is the only sign of a dead connection.
 */
const WATCHDOG_MS = 45_000;

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

/** The signed-in user's sync client. The watchdog reads synced rows through it. */
let syncedRows: Replicache<ClientMutators> | null = null;

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

/**
 * A turn that expects frames: live, and not parked on an approval. A parked run is silent by
 * design (ADR-0099).
 */
function expectsFrames(entry: ThreadStream): boolean {
  const cur = entry.cell.current;

  return cur !== null && !cur.done && !cur.awaitingApproval;
}

/** Any frame proves the bus is alive, so each one moves the deadline for every live turn. */
function armWatchdog(): void {
  if (watchdogId !== null) {
    clearTimeout(watchdogId);
    watchdogId = null;
  }

  if (![...threads.values()].some(expectsFrames)) return;
  watchdogId = window.setTimeout(() => {
    watchdogId = null;
    void recoverStalledTurns();
  }, WATCHDOG_MS);
}

/** The ids in `messageIds` that have a synced row. A failed read gives none. */
async function readSyncedMessageIds(messageIds: string[]): Promise<Set<string>> {
  const rep = syncedRows;

  if (!rep) return new Set();

  return rep
    .query(async (tx) => {
      const found = new Set<string>();

      for (const id of messageIds) {
        if ((await SYNC_MODEL.chatmsg.get(tx, { id })) !== null) found.add(id);
      }

      return found;
    })
    .catch((err: unknown) => {
      console.warn("[chat] synced row read failed:", toMessage(err));

      return new Set<string>();
    });
}

/**
 * No frame came for a live turn. Do not fail it: the run can be healthy and silent (a long tool
 * call, a compaction). A turn whose synced row is here closed on the server, so close it; the row
 * shows the outcome, a failure too. For the rest, reconnect the bus in silence, so the `?since`
 * replay resends any frame the old connection lost. The next deadline repeats this check.
 */
async function recoverStalledTurns(): Promise<void> {
  const stalled = [...threads].flatMap(([threadId, entry]) => {
    const cur = entry.cell.current;

    return cur !== null && expectsFrames(entry)
      ? [{ threadId, entry, messageId: cur.messageId }]
      : [];
  });

  if (stalled.length === 0) return;
  const closed = await readSyncedMessageIds(stalled.map(({ messageId }) => messageId));

  for (const { threadId, entry, messageId } of stalled) {
    // A sign-out during the read cleared the map.
    if (threads.get(threadId) !== entry || !closed.has(messageId)) continue;

    if (applySyncedClose(entry.cell, messageId)) scheduleProjection(entry);
    releaseIfSettled(threadId, entry);
  }

  // A frame during the read re-armed the watchdog, so the bus is alive.
  if (watchdogId !== null || ![...threads.values()].some(expectsFrames)) return;
  reconnectEventStream();
  armWatchdog();
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
    default:
      return assertNever(frame, "event frame kind");
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

/**
 * Keep every thread's live turn current while the app runs. Mount once, in the app shell,
 * so a turn keeps its frames while the user is on another page.
 */
export function useChatStreamStore(): void {
  const { data: session } = authClient.useSession();
  const userId = session?.user.id;
  const rep = useReplicache();

  useEffect(() => {
    syncedRows = rep;

    return () => {
      if (syncedRows === rep) syncedRows = null;
    };
  }, [rep]);

  useEffect(() => {
    if (!userId) return;
    // A fatal bus close reconnects in silence, and the `?since` replay resumes each turn.
    const close = openEventStream({ onFrame });

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
