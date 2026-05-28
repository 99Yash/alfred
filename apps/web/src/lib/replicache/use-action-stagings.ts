import { IDB_KEY, syncedActionStagingSchema, type SyncedActionStaging } from "@alfred/sync";
import { useEffect, useState } from "react";
import type { ReadTransaction } from "replicache";
import { useReplicache } from "./context";

export interface ActionStagingsState {
  /** Pending approvals, newest first. Empty while loading. */
  rows: SyncedActionStaging[];
  /** True until the first subscription result lands. */
  loading: boolean;
}

/**
 * Live view of the user's pending action approvals.
 *
 * The server pull only emits `status='pending' AND requires_approval` rows
 * (see `ENTITY_FETCHERS.ACTION_STAGING`), so this scan is already the
 * approval queue — no client-side status filtering needed. Rows that fail
 * schema validation are dropped rather than crashing the page; a malformed
 * row should never take the whole queue down.
 */
export function useActionStagings(): ActionStagingsState {
  const rep = useReplicache();
  const [rows, setRows] = useState<SyncedActionStaging[] | null>(null);

  useEffect(() => {
    if (!rep) {
      setRows(null);
      return;
    }

    const prefix = IDB_KEY.ACTION_STAGING({});
    return rep.subscribe(
      async (tx: ReadTransaction) => tx.scan({ prefix }).values().toArray(),
      (values) => {
        const parsed: SyncedActionStaging[] = [];
        for (const value of values) {
          const result = syncedActionStagingSchema.safeParse(value);
          if (result.success) parsed.push(result.data);
        }
        parsed.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setRows(parsed);
      },
    );
  }, [rep]);

  return { rows: rows ?? [], loading: rows === null };
}
