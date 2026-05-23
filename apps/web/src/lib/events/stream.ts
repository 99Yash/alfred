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

/**
 * Open an SSE connection to /api/events. Returns a `close()` to tear down.
 *
 * The browser EventSource handles auto-reconnect with exponential backoff and
 * automatically sends `Last-Event-ID` from the most recent `id:` line, so the
 * server can replay events the client missed across drops.
 */
export function openEventStream(opts: OpenEventStreamOptions): () => void {
  const url = new URL(`${API_URL}/api/events/`);
  if (typeof opts.since === "number" && Number.isFinite(opts.since)) {
    url.searchParams.set("since", String(opts.since));
  }

  const source = new EventSource(url.toString(), { withCredentials: true });

  const handle = (kind: EventKind) => (msg: MessageEvent) => {
    try {
      const parsed = JSON.parse(msg.data) as { payload?: unknown; createdAt?: string };
      const payloadResult = eventPayloadSchemas[kind].safeParse(parsed.payload);
      if (!payloadResult.success) return;
      const id = Number(msg.lastEventId);
      if (!Number.isFinite(id) || id <= 0) return;
      const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt : "";
      opts.onFrame({ id, kind, payload: payloadResult.data, createdAt });
    } catch {
      // Drop malformed frames silently.
    }
  };

  for (const kind of EVENT_KINDS) {
    source.addEventListener(kind, handle(kind));
  }
  source.onerror = (err) => {
    opts.onError?.(err);
  };

  return () => source.close();
}

export { isKnownKind };
