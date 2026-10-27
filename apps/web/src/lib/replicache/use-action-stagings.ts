import { SYNC_MODEL, type SyncedActionStaging } from "@alfred/sync";
import type { ReadTransaction } from "replicache";
import { useReplicacheSubscription } from "./use-replicache-subscription";

function scanActionStagings(tx: ReadTransaction): Promise<SyncedActionStaging[]> {
  return SYNC_MODEL.actionstaging.scan(tx);
}

function newestFirst(values: SyncedActionStaging[]): SyncedActionStaging[] {
  return values.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface ActionStagingsState {
  /** Pending approvals, newest first. */
  rows: SyncedActionStaging[];
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/** Pending approvals. The server syncs only pending rows that need approval, so no filter here. */
export function useActionStagings(): ActionStagingsState {
  const { data, loading, error, retry } = useReplicacheSubscription(
    scanActionStagings,
    newestFirst,
  );

  return { rows: data ?? [], loading, error, retry };
}
