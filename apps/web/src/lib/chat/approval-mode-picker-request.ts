import { useCallback, useSyncExternalStore } from "react";

/**
 * A request to open the approval mode picker of one chat thread (ADR-0130 amendment (c)). Full
 * Autonomy always opens the picker of ADR-0069, so no other control turns it on at once. A control
 * in the thread (the card, the saved reply) or on `/approvals` sets the request. The chat shell
 * of that thread opens its picker and clears the request. Client only.
 */
let requestedThreadId: string | null = null;

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
