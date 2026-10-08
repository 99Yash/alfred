import { SYNC_MODEL, type SyncedActionStaging } from "@alfred/sync";
import { useEffect, useState } from "react";
import type { ReadTransaction } from "replicache";
import { useReplicacheStatus } from "./context";

export interface ActionStagingsState {
  /** Pending approvals, newest first. */
  rows: SyncedActionStaging[];
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/** Pending approvals. The server syncs only pending rows that need approval, so no filter here. */
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
