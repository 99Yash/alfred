import { EVENT_KINDS } from "@alfred/contracts/events";
import { parseEventFrame, type EventStreamFrame } from "./frame";
import { getReplaySince, noteReplayFrame } from "./replay-anchor";

const API_URL =
  (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? "http://localhost:3001";

export interface OpenEventStreamOptions {
  onFrame: (frame: EventStreamFrame) => void;
  onError?: ((err: Event) => void) | undefined;
}

interface EventStreamSubscriber {
  onFrame: (frame: EventStreamFrame) => void;
  onError?: ((err: Event) => void) | undefined;
}

interface SharedEventStream {
  source: EventSource;
  subscribers: Map<number, EventStreamSubscriber>;
  nextId: number;
}

let sharedStream: SharedEventStream | null = null;

function eventStreamUrl(): URL {
  const url = new URL(`${API_URL}/api/events/`);
  const anchor = getReplaySince();
  if (anchor > 0) url.searchParams.set("since", String(anchor));
  return url;
}

function createEventSource(
  onFrame: (frame: EventStreamFrame) => void,
  onError: (err: Event) => void,
): EventSource {
  const source = new EventSource(eventStreamUrl().toString(), { withCredentials: true });

  for (const kind of EVENT_KINDS) {
    source.addEventListener(kind, (msg) => {
      const frame = parseEventFrame(kind, msg);
      if (frame) onFrame(frame);
    });
  }
  source.onerror = onError;

  return source;
}

/**
 * Open an SSE connection to /api/events. Returns a `close()` to tear down.
 *
 * All callers share one connection. Browser EventSource handles auto-reconnect
 * and automatically sends `Last-Event-ID` from the most recent `id:` line, so
 * the server can replay events missed across drops. That header is lost on a
 * full page reload, so we also pass the persisted recovery cursor from
 * `replay-anchor` as `?since` when the page reconnects.
 */
export function openEventStream(opts: OpenEventStreamOptions): () => void {
  if (!sharedStream) {
    const subscribers = new Map<number, EventStreamSubscriber>();
    sharedStream = {
      source: createEventSource(
        (frame) => {
          noteReplayFrame(frame);
          for (const subscriber of subscribers.values()) {
            subscriber.onFrame(frame);
          }
        },
        (err) => {
          for (const subscriber of subscribers.values()) {
            subscriber.onError?.(err);
          }
        },
      ),
      subscribers,
      nextId: 1,
    };
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
      stream.source.close();
      if (sharedStream === stream) sharedStream = null;
    }
  };
}
