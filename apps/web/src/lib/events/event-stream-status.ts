import { useSyncExternalStore } from "react";

export type EventStreamStatus = "connected" | "connecting" | "reconnecting" | "disconnected";

/**
 * Shared SSE connection state. Transitions are not type-checked:
 *   disconnected -> connecting -> connected -> (drop) connecting
 *   connected -> (fatal CLOSED) reconnecting -> (backoff) connecting
 */
let eventStreamStatus: EventStreamStatus = "disconnected";

const statusListeners = new Set<() => void>();

export function setEventStreamStatus(next: EventStreamStatus): void {
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
  return useSyncExternalStore(
    subscribeToEventStreamStatus,
    getEventStreamStatus,
    () => "disconnected",
  );
}
