import { EVENT_KINDS } from "@alfred/contracts/events";
import { parseEventFrame, type EventStreamFrame } from "./frame";
import { getReplaySince, noteReplayFrame } from "./replay-anchor";
import { API_URL } from "~/lib/eden";
import { getEventStreamStatus, setEventStreamStatus } from "./event-stream-status";

export interface OpenEventStreamOptions {
  onFrame: (frame: EventStreamFrame) => void;
}

interface EventStreamSubscriber {
  onFrame: (frame: EventStreamFrame) => void;
}

interface SharedEventStream {
  source: EventSource | null;
  subscribers: Map<number, EventStreamSubscriber>;
  nextId: number;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

let sharedStream: SharedEventStream | null = null;

function eventStreamUrl(): URL {
  const url = new URL(`${API_URL}/api/events/`);
  const anchor = getReplaySince();

  if (anchor > 0) url.searchParams.set("since", String(anchor));

  return url;
}

/** Backoff after a fatal CLOSED (for example a 401), which the browser never retries. */
const RECONNECT_BASE_MS = 1_000;

const RECONNECT_MAX_MS = 30_000;

function backoffMs(attempt: number): number {
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);

  // ±15% jitter so many tabs do not retry in the same second.
  return Math.round(base * (0.85 + Math.random() * 0.3));
}

function attachSource(shared: SharedEventStream): void {
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
    shared.reconnectAttempts = 0;
    setEventStreamStatus("connected");
  };

  source.onerror = () => {
    // A non-2xx goes to CLOSED with no auto-retry. A transport drop stays CONNECTING and retries.
    const isFatal = source.readyState === EventSource.CLOSED;

    if (isFatal) {
      // Keep the subscriber map so a reconnect needs no re-subscribe.
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
        setEventStreamStatus("disconnected");

        return;
      }

      const attempt = shared.reconnectAttempts;
      shared.reconnectAttempts += 1;
      const delay = backoffMs(attempt);
      setEventStreamStatus("reconnecting");

      if (shared.reconnectTimer) clearTimeout(shared.reconnectTimer);
      shared.reconnectTimer = setTimeout(() => {
        shared.reconnectTimer = null;

        if (shared.subscribers.size === 0) {
          if (sharedStream === shared) sharedStream = null;
          setEventStreamStatus("disconnected");

          return;
        }

        setEventStreamStatus("connecting");
        attachSource(shared);
      }, delay);
    } else {
      // The browser retries a transient drop. Show the state but do not fan out an error.
      setEventStreamStatus("connecting");
    }
  };

  shared.source = source;
  const curStatus = getEventStreamStatus();

  if (curStatus === "reconnecting" || curStatus === "disconnected") {
    setEventStreamStatus("connecting");
  }
}

/**
 * Subscribe to the one shared SSE connection to /api/events. Returns the unsubscribe.
 * A reload loses `Last-Event-ID`, so the persisted cursor goes out as `?since`.
 * A fatal close retries with backoff, and the `?since` replay resends what the gap lost.
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
    setEventStreamStatus("connecting");
    attachSource(sharedStream);
  } else if (!sharedStream.source && !sharedStream.reconnectTimer) {
    // A torn-down source with no pending retry. Re-attach so the new subscriber is not on a dead bus.
    setEventStreamStatus("connecting");
    attachSource(sharedStream);
  }

  const stream = sharedStream;
  const subscriberId = stream.nextId;
  stream.nextId += 1;
  stream.subscribers.set(subscriberId, { onFrame: opts.onFrame });

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
      setEventStreamStatus("disconnected");
    }
  };
}

/**
 * Replace the shared source now, with no status change. A half-open connection gives no error,
 * so a caller that expects frames calls this. The new URL takes the `?since` anchor, so the replay
 * resends the frames the old source lost. A pending backoff retry already does the same.
 */
export function reconnectEventStream(): void {
  const shared = sharedStream;

  if (!shared || shared.subscribers.size === 0 || shared.reconnectTimer) return;

  if (shared.source) {
    try {
      shared.source.close();
    } catch {
      // ignore
    }

    shared.source = null;
  }

  attachSource(shared);
}
