import {
  EVENT_KINDS,
  eventPayloadSchemas,
  type EventFrame,
  type EventKind,
} from "@alfred/contracts/events";
import { getStringPath, isRecord, safeJsonParse } from "@alfred/contracts";
import { getLocalStorageItem, setLocalStorageItem } from "~/lib/storage/storage";

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
  onFrame: (frame: EventStreamFrame) => void;
  onError?: (err: Event) => void;
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

// ---------------------------------------------------------------------------
// Replay anchor — lets a mid-flight turn survive a full page reload.
//
// The browser only re-sends `Last-Event-ID` when the SAME EventSource
// auto-reconnects; a page refresh destroys it, so a turn that was streaming
// comes back blank until the next live flush. During a thinking or tool-call
// gap that flush can be ~10s away, so the bubble reads as stalled/errored.
//
// We persist an outbox-row id and pass it as `?since` on the next connect, so
// the server replays the in-flight turn. The anchor must sit just BEFORE the
// current turn's first frame, so we FREEZE it while any turn is streaming
// (tracked via `chat.message` started/completed) and only advance it to the
// latest seen id while idle. Reload mid-turn → `?since` replays the whole turn;
// idle → the anchor is current, so nothing already-completed replays.
// ---------------------------------------------------------------------------

const REPLAY_ANCHOR_KEY = "alfred.events.replayAnchor" as const;
let maxSeenId = 0;
let lastPersistedAnchor = 0;
const activeRuns = new Set<string>();
let anchorSeeded = false;

function noteFrame(frame: EventStreamFrame): void {
  if (!anchorSeeded) {
    anchorSeeded = true;
    lastPersistedAnchor = getLocalStorageItem(REPLAY_ANCHOR_KEY);
    maxSeenId = lastPersistedAnchor;
  }
  if (frame.id > maxSeenId) maxSeenId = frame.id;

  // Track in-flight turns so the anchor stays behind the earliest active one.
  if (frame.kind === "chat.message" && isRecord(frame.payload)) {
    const runId = frame.payload.runId;
    if (typeof runId === "string") {
      if (frame.payload.phase === "started") {
        // A turn is beginning. Pin the anchor just before this frame so a
        // reload replays the whole turn — even on the very first turn of a
        // fresh page, where no prior completion has written an anchor yet.
        // `frame.id - 1` never lowers a higher anchor an earlier turn left.
        if (activeRuns.size === 0) persistAnchor(frame.id - 1);
        activeRuns.add(runId);
      } else if (frame.payload.phase === "completed") {
        activeRuns.delete(runId);
      }
    }
  }

  // Advance the anchor only when nothing is streaming. High-frequency frames
  // (reasoning/delta) arrive only mid-turn, when this is frozen — so writes are
  // sparse (roughly one per turn, on completion) without any throttle.
  if (activeRuns.size === 0) persistAnchor(maxSeenId);
}

function persistAnchor(id: number): void {
  if (id <= lastPersistedAnchor) return;
  lastPersistedAnchor = id;
  setLocalStorageItem(REPLAY_ANCHOR_KEY, id);
}

function eventStreamUrl(): URL {
  const url = new URL(`${API_URL}/api/events/`);
  const anchor = getLocalStorageItem(REPLAY_ANCHOR_KEY);
  if (anchor > 0) url.searchParams.set("since", String(anchor));
  return url;
}

function parseFrame(kind: EventKind, msg: MessageEvent): EventStreamFrame | null {
  const parsed = safeJsonParse(msg.data);
  if (!isRecord(parsed)) return null;
  const payloadResult = eventPayloadSchemas[kind].safeParse(parsed.payload);
  if (!payloadResult.success) return null;
  const id = Number(msg.lastEventId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return {
    id,
    kind,
    payload: payloadResult.data,
    createdAt: getStringPath(parsed, "createdAt") ?? "",
  };
}

function createEventSource(
  onFrame: (frame: EventStreamFrame) => void,
  onError: (err: Event) => void,
): EventSource {
  const source = new EventSource(eventStreamUrl().toString(), { withCredentials: true });

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
 * All callers share one connection. Browser EventSource handles auto-reconnect
 * and automatically sends `Last-Event-ID` from the most recent `id:` line, so
 * the server can replay events missed across drops. That header is lost on a
 * full page reload, so we also pass a persisted `?since` anchor (see
 * `noteFrame`) to replay a turn that was mid-flight when the page reloaded.
 */
export function openEventStream(opts: OpenEventStreamOptions): () => void {
  if (!sharedStream) {
    const subscribers = new Map<number, EventStreamSubscriber>();
    sharedStream = {
      source: createEventSource(
        (frame) => {
          noteFrame(frame);
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
