import type { SyncedChatAttachment, SyncedChatMessage } from "@alfred/sync";
import { useSyncExternalStore } from "react";

/**
 * The user's message from submit until its Replicache mirror lands, so the bubble shows at once.
 * Client only: the mirror waits for the turn ack, because a pushed row cannot be taken back
 * when the start fails or meets `busy`. The chat read hooks merge it in until the real row syncs.
 */
interface PendingTurn {
  message: SyncedChatMessage;
  attachments: SyncedChatAttachment[];
}

// One per thread: the composer holds a second send until the first settles.
const pendingByThread = new Map<string, PendingTurn>();

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

export function setPendingTurn(turn: PendingTurn): void {
  pendingByThread.set(turn.message.threadId, turn);
  emit();
}

/** A no-op when a newer send replaced this message. */
export function clearPendingTurn(threadId: string, messageId: string): void {
  if (pendingByThread.get(threadId)?.message.id !== messageId) return;
  pendingByThread.delete(threadId);
  emit();
}

export function usePendingTurn(threadId: string | undefined): PendingTurn | null {
  return useSyncExternalStore(
    subscribe,
    () => (threadId ? (pendingByThread.get(threadId) ?? null) : null),
    () => null,
  );
}
