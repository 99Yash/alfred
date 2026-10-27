import { SYNC_MODEL, type SyncedActionStaging } from "@alfred/sync";
import type { ReadTransaction } from "replicache";
import { toStagedRow, type StagedRow } from "~/components/approvals/ask-user";
import { useReplicacheSubscription } from "./use-replicache-subscription";

function scanActionStagings(tx: ReadTransaction): Promise<SyncedActionStaging[]> {
  return SYNC_MODEL.actionstaging.scan(tx);
}

/** Runs one time per synced change, so each row is classified in one place. */
function toRowsNewestFirst(values: SyncedActionStaging[]): StagedRow[] {
  return values.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)).map(toStagedRow);
}

export interface ActionStagingsState {
  /** Pending approvals, newest first, each classified as a question or a write. */
  rows: StagedRow[];
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/** Pending approvals. The server syncs only pending rows that need approval, so no filter here. */
export function useActionStagings(): ActionStagingsState {
  const { data, loading, error, retry } = useReplicacheSubscription(
    scanActionStagings,
    toRowsNewestFirst,
  );

  return { rows: data ?? [], loading, error, retry };
}
