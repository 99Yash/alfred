import { useSyncExternalStore } from "react";

export type EventStreamStatus = "connected" | "connecting" | "reconnecting" | "disconnected";

/**
 * Shared SSE connection lifecycle.
 *
 * State machine (Tier 5 → documented but not type-enforced):
 *   disconnected --open--> connecting --onopen--> connected --transient drop--> connecting
 *                                          \--fatal CLOSED--> reconnecting --backoff--> connecting
 *   All edges funnel through `setStatus`; no external module writes the variable.
 *   A future tightening would replace the string union with a discriminated
 *   transition helper (Tier 1) rather than allowing any `setStatus` call.
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
  // SAFETY: "disconnected" is a member of EventStreamStatus; the cast closes the generic.
  return useSyncExternalStore(
    subscribeToEventStreamStatus,
    getEventStreamStatus,
    () => "disconnected" as EventStreamStatus,
  );
}
