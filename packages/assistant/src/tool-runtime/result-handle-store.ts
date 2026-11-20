import type { JsonValue } from "@alfred/contracts";
import { bootPort } from "@alfred/assistant/boot-port";

/** How long a handle stays readable after its fetch (owner, 2026-11-20). */
export const RESULT_HANDLE_TTL_DAYS = 3;

export const RESULT_HANDLE_TTL_MS = RESULT_HANDLE_TTL_DAYS * 24 * 60 * 60 * 1000;

/** A stored result as the park step and `system.load_result` see it (ADR-0087). */
export interface StoredResultRef {
  handle: string;
  fetchedAt: Date;
}

interface StoredResult extends StoredResultRef {
  toolName: string;
  query: string;
  value: JsonValue;
}

/**
 * Surface:  chat.
 * Owns/hides: the handle store (ADR-0087 point 2, ADR-0130 decision 5). Hides object storage and
 *   the `result_handles` row.
 * Why the seam: inverts tool-runtime -> chat, which owns the thread's storage prefix.
 * Wiring: chat/result-handle-store.ts installs; internal/result-handles.ts and the
 *   `system.load_result` tool read. No store: no handle, and the bound note keeps its read-again
 *   advice.
 */
export interface ResultHandleStore {
  /**
   * Store `value` for the call, or return the handle that an earlier attempt of the same call
   * stored, so a replay gives the same handle. `null` when storage is not available.
   */
  park(args: {
    userId: string;
    threadId: string;
    messageId: string;
    runId: string;
    toolCallId: string;
    toolName: string;
    query: string;
    itemCount: number | null;
    /**
     * When the data was fetched. A value that a script made from stored results keeps the oldest
     * fetch time of those results, so old data does not look new.
     */
    fetchedAt: Date;
    value: JsonValue;
  }): Promise<StoredResultRef | null>;
  /** The live stored result of this thread, or `null` when it is unknown, expired, or not this thread's. */
  load(args: { userId: string; threadId: string; handle: string }): Promise<StoredResult | null>;
}

const resultHandleStorePort = bootPort<ResultHandleStore>("result handle store");

/** Chat installs the handle store at boot. */
export function registerResultHandleStore(store: ResultHandleStore): () => void {
  return resultHandleStorePort.install(store);
}

/** The installed handle store, or `undefined` in a process that has none. */
export function resultHandleStore(): ResultHandleStore | undefined {
  return resultHandleStorePort.peek();
}
