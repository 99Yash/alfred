import { SYNC_MODEL, type SyncedActionStaging } from "@alfred/sync";
import { useEffect, useState } from "react";
import type { ReadTransaction } from "replicache";
import { useReplicacheStatus } from "./context";

export interface ActionStagingsState {
  /** Pending approvals, newest first. Empty while loading. */
  rows: SyncedActionStaging[];
  /** True until the first subscription result lands. */
  loading: boolean;
  /** Replicache client load failure, if sync could not start. */
  error: string | null;
  retry: () => void;
}

/**
 * Live view of the user's pending action approvals.
 *
 * The server pull only emits `status='pending' AND requires_approval` rows
 * (see `ENTITY_FETCHERS.actionstaging`), so this scan is already the
 * approval queue — no client-side status filtering needed. Rows that fail
 * schema validation are dropped rather than crashing the page; a malformed
 * row should never take the whole queue down.
 */
export function useActionStagings(): ActionStagingsState {
  const { rep, loadError, retry } = useReplicacheStatus();
  const [rows, setRows] = useState<SyncedActionStaging[] | null>(null);

  useEffect(() => {
    if (!rep) {
      setRows(null);
      return;
    }

    return rep.subscribe(
      (tx: ReadTransaction) => SYNC_MODEL.actionstaging.scan(tx),
      (values) => {
        values.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setRows(values);
      },
    );
  }, [rep]);

  return { rows: rows ?? [], loading: rows === null && !loadError, error: loadError, retry };
}
