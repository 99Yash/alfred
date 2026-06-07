import {
  EVENT_KINDS,
  eventPayloadSchemas,
  isKnownEventKind,
  type EventFrame,
  type EventKind,
} from "@alfred/schemas/events";

const API_URL =
  (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? "http://localhost:3001";

export interface EventStreamFrame extends Pick<EventFrame, "id" | "kind" | "createdAt"> {
  /**
   * Browser-validated payload as `unknown` — consumers should narrow with a
   * zod schema or a type guard before use. The server validates on publish,
   * but the SSE wire format is JSON and we treat it as untrusted.
   */
  payload: unknown;
}

export interface OpenEventStreamOptions {
  /** Outbox row id to replay from. Optional. EventSource also auto-passes Last-Event-ID on reconnect. */
  since?: number;
  onFrame: (frame: EventStreamFrame) => void;
  onError?: (err: Event) => void;
}

function isKnownKind(value: string): value is EventKind {
  return isKnownEventKind(value);
}

interface EventStreamSubscriber {
  onFrame: (frame: EventStreamFrame) => void;
  onError?: (err: Event) => void;
}

interface SharedEventStream {
  source: EventSource;
  subscribers: Map<number, EventStreamSubscriber>;
  nextId: number;
}

let sharedStream: SharedEventStream | null = null;

function eventStreamUrl(since?: number): URL {
  const url = new URL(`${API_URL}/api/events/`);
  if (typeof since === "number" && Number.isFinite(since)) {
    url.searchParams.set("since", String(since));
  }
  return url;
}

function parseFrame(kind: EventKind, msg: MessageEvent): EventStreamFrame | null {
  try {
    const parsed = JSON.parse(msg.data) as { payload?: unknown; createdAt?: string };
    const payloadResult = eventPayloadSchemas[kind].safeParse(parsed.payload);
    if (!payloadResult.success) return null;
    const id = Number(msg.lastEventId);
    if (!Number.isFinite(id) || id <= 0) return null;
    const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt : "";
    return { id, kind, payload: payloadResult.data, createdAt };
  } catch {
    return null;
  }
}

function createEventSource(
  since: number | undefined,
  onFrame: (frame: EventStreamFrame) => void,
  onError: (err: Event) => void,
): EventSource {
  const source = new EventSource(eventStreamUrl(since).toString(), { withCredentials: true });

  for (const kind of EVENT_KINDS) {
    source.addEventListener(kind, (msg) => {
      const frame = parseFrame(kind, msg);
      if (frame) onFrame(frame);
    });
  }
  source.onerror = onError;

  return source;
}

/**
 * Open an SSE connection to /api/events. Returns a `close()` to tear down.
 *
 * The browser EventSource handles auto-reconnect with exponential backoff and
 * automatically sends `Last-Event-ID` from the most recent `id:` line, so the
 * server can replay events the client missed across drops.
 */
export function openEventStream(opts: OpenEventStreamOptions): () => void {
  if (typeof opts.since === "number" && Number.isFinite(opts.since)) {
    const source = createEventSource(opts.since, opts.onFrame, (err) => opts.onError?.(err));
    return () => source.close();
  }

  if (!sharedStream) {
    const subscribers = new Map<number, EventStreamSubscriber>();
    sharedStream = {
      source: createEventSource(
        undefined,
        (frame) => {
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

export { isKnownKind };
