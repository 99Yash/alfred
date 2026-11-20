import { useCallback, useSyncExternalStore } from "react";

/**
 * A request to open the approval mode picker of one chat thread (ADR-0130 amendment (c)). Full
 * Autonomy always opens the picker of ADR-0069, so no other control turns it on at once. A control
 * in the thread (the card, the saved reply) or on `/approvals` sets the request. The picker of
 * that thread opens and clears the request. A request that no picker takes expires, so a later
 * visit to the thread does not open the picker by itself. Client only.
 */
let requestedThreadId: string | null = null;

/** Long enough for a jump from `/approvals` to load the thread row. */
const REQUEST_TTL_MS = 10_000;

let expiryTimer: ReturnType<typeof setTimeout> | undefined;

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

/** Ask the chat shell of `threadId` to open its approval mode picker. */
export function requestApprovalModePicker(threadId: string): void {
  requestedThreadId = threadId;
  clearTimeout(expiryTimer);

  expiryTimer = setTimeout(() => {
    requestedThreadId = null;
    emit();
  }, REQUEST_TTL_MS);

  emit();
}

export interface ApprovalModePickerRequest {
  /** A control asked to open the picker of this thread. */
  requested: boolean;
  clear: () => void;
}

/** The request for this thread. `undefined` (a new chat with no thread) never has a request. */
export function useApprovalModePickerRequest(
  threadId: string | undefined,
): ApprovalModePickerRequest {
  const requested = useSyncExternalStore(
    subscribe,
    () => threadId !== undefined && requestedThreadId === threadId,
    () => false,
  );

  const clear = useCallback(() => {
    if (threadId === undefined || requestedThreadId !== threadId) return;
    requestedThreadId = null;
    emit();
  }, [threadId]);

  return { requested, clear };
}
