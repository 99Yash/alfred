import { useSyncExternalStore } from "react";
import { EVENT_KINDS } from "@alfred/contracts/events";
import { parseEventFrame, type EventStreamFrame } from "./frame";
import { getReplaySince, noteReplayFrame } from "./replay-anchor";
import { API_URL } from "~/lib/eden";

export interface OpenEventStreamOptions {
  onFrame: (frame: EventStreamFrame) => void;
  onError?: ((err: Event) => void) | undefined;
}

interface EventStreamSubscriber {
  onFrame: (frame: EventStreamFrame) => void;
  onError?: ((err: Event) => void) | undefined;
}

export type EventStreamStatus = "connected" | "connecting" | "reconnecting" | "disconnected";

interface SharedEventStream {
  source: EventSource | null;
  subscribers: Map<number, EventStreamSubscriber>;
  nextId: number;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

let sharedStream: SharedEventStream | null = null;

let eventStreamStatus: EventStreamStatus = "disconnected";
const statusListeners = new Set<() => void>();

function setStatus(next: EventStreamStatus): void {
  if (eventStreamStatus === next) return;
  eventStreamStatus = next;
  for (const cb of statusListeners) cb();
}

export function getEventStreamStatus(): EventStreamStatus {
  return eventStreamStatus;
}

export function subscribeToEventStreamStatus(cb: () => void): () => void {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

export function useEventStreamStatus(): EventStreamStatus {
  // SAFETY: "disconnected" is a member of EventStreamStatus; the cast closes the generic.
  return useSyncExternalStore(subscribeToEventStreamStatus, getEventStreamStatus, () => "disconnected" as EventStreamStatus);
}

function eventStreamUrl(): URL {
  const url = new URL(`${API_URL}/api/events/`);
  const anchor = getReplaySince();
  if (anchor > 0) url.searchParams.set("since", String(anchor));
  return url;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

function backoffMs(attempt: number): number {
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
  // Small jitter so a fleet of tabs does not thunder-herd on the same second.
  return Math.round(base * (0.85 + Math.random() * 0.3));
}

function attachSource(shared: SharedEventStream): void {
  // If a source is already attached, do not create another.
  if (shared.source) return;
  // Fresh URL on every (re)connect so the replay anchor advances.
  const source = new EventSource(eventStreamUrl().toString(), { withCredentials: true });

  const onFrame = (frame: EventStreamFrame) => {
    noteReplayFrame(frame);
    for (const subscriber of shared.subscribers.values()) {
      subscriber.onFrame(frame);
    }
  };

  for (const kind of EVENT_KINDS) {
    source.addEventListener(kind, (msg) => {
      const frame = parseEventFrame(kind, msg);
      if (frame) onFrame(frame);
    });
  }

  source.onopen = () => {
    // A successful open resets the backoff window and marks the bus live.
    shared.reconnectAttempts = 0;
    setStatus("connected");
  };

  source.onerror = (err) => {
    // Per WHATWG: a 401 (or other non-2xx) transitions to CLOSED and fires
    // error exactly once WITHOUT auto-reconnect. A transport drop stays in
    // CONNECTING and auto-reconnects. Only the CLOSED case is fatal and needs
    // an explicit backoff re-open plus subscriber notification.
    const isFatal = source.readyState === EventSource.CLOSED;
    if (isFatal) {
      for (const subscriber of shared.subscribers.values()) {
        subscriber.onError?.(err);
      }
      // Tear down the dead source. Keep the shared object (and its subscriber
      // map) so a reconnect can re-attach without callers re-subscribing.
      try {
        source.close();
      } catch {
        // ignore
      }
      if (shared.source === source) shared.source = null;

      if (shared.subscribers.size === 0) {
        if (shared.reconnectTimer) {
          clearTimeout(shared.reconnectTimer);
          shared.reconnectTimer = null;
        }
        if (sharedStream === shared) sharedStream = null;
        setStatus("disconnected");
        return;
      }

      const attempt = shared.reconnectAttempts;
      shared.reconnectAttempts += 1;
      const delay = backoffMs(attempt);
      setStatus("reconnecting");
      if (shared.reconnectTimer) clearTimeout(shared.reconnectTimer);
      shared.reconnectTimer = setTimeout(() => {
        shared.reconnectTimer = null;
        if (shared.subscribers.size === 0) {
          if (sharedStream === shared) sharedStream = null;
          setStatus("disconnected");
          return;
        }
        // Re-entering connecting before the new EventSource fires onopen/onerror.
        setStatus("connecting");
        attachSource(shared);
      }, delay);
    } else {
      // Transient drop — the browser will auto-retry; do not fan out as a
      // fatal error, but surface the intermediate state so a banner can show
      // "reconnecting" without spamming error toasts / flipping the chat bubble.
      setStatus("connecting");
    }
  };

  shared.source = source;
  // The new source starts in CONNECTING; if we were previously reconnecting
  // (backoff), we now transition to connecting until onopen confirms.
  if (eventStreamStatus === "reconnecting" || eventStreamStatus === "disconnected") {
    setStatus("connecting");
  }
}

/**
 * Open an SSE connection to /api/events. Returns a `close()` to tear down.
 *
 * All callers share one connection. Browser EventSource handles auto-reconnect
 * and automatically sends `Last-Event-ID` from the most recent `id:` line, so
 * the server can replay events missed across drops. That header is lost on a
 * full page reload, so we also pass the persisted recovery cursor from
 * `replay-anchor` as `?since` when the page reconnects.
 *
 * On a fatal transport error (e.g. 401 — the session cookie expired — which
 * moves the source to CLOSED with no auto-reconnect per WHATWG), the shared
 * source is torn down and re-opened on an exponential backoff while any
 * subscribers remain. Each subscriber's `onError` is invoked exactly once for
 * that fatal error so an in-flight chat turn can flip to a failed/done state
 * instead of hanging on the stop button forever.
 */
export function openEventStream(opts: OpenEventStreamOptions): () => void {
  if (!sharedStream) {
    sharedStream = {
      source: null,
      subscribers: new Map<number, EventStreamSubscriber>(),
      nextId: 1,
      reconnectAttempts: 0,
      reconnectTimer: null,
    };
    setStatus("connecting");
    attachSource(sharedStream);
  } else if (!sharedStream.source && !sharedStream.reconnectTimer) {
    // Fatal error tore down the source but the timer was cleared (e.g. by a
    // previous last-subscriber teardown that raced a new subscriber). Re-attach
    // immediately rather than leaving the new subscriber on a dead bus.
    setStatus("connecting");
    attachSource(sharedStream);
  }

  const stream = sharedStream;
  const subscriberId = stream.nextId;
  stream.nextId += 1;
  stream.subscribers.set(subscriberId, {
    onFrame: opts.onFrame,
    onError: opts.onError,
  });

  return () => {
    stream.subscribers.delete(subscriberId);
    if (stream.subscribers.size === 0) {
      if (stream.source) {
        try {
          stream.source.close();
        } catch {
          // ignore
        }
        stream.source = null;
      }
      if (stream.reconnectTimer) {
        clearTimeout(stream.reconnectTimer);
        stream.reconnectTimer = null;
      }
      if (sharedStream === stream) sharedStream = null;
      setStatus("disconnected");
    }
  };
}
