import { SYNC_MODEL, type SyncedFact } from "@alfred/sync";
import { useCallback } from "react";
import type { ReadTransaction } from "replicache";
import { useReplicache } from "~/lib/replicache/context";
import { useReplicacheSubscription } from "~/lib/replicache/use-replicache-subscription";

interface MemoryFactsState {
  facts: SyncedFact[];
  loading: boolean;
  error: string | null;
  initialPullPending: boolean;
  retry: () => void;
  confirmFact: (id: string) => Promise<void>;
  rejectFact: (id: string) => Promise<void>;
}

const scanFacts = (tx: ReadTransaction) => SYNC_MODEL.fact.scan(tx);

const newestFirst = (facts: SyncedFact[]) =>
  facts.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));

/** Live, schema-validated facts used only by the memory review surface. */
export function useMemoryFacts(): MemoryFactsState {
  const rep = useReplicache();

  const { data, loading, error, initialPullPending, retry } = useReplicacheSubscription(
    scanFacts,
    newestFirst,
  );

  const confirmFact = useCallback(
    async (id: string): Promise<void> => {
      if (!rep) return;
      await rep.mutate.factConfirm({ factId: id });
    },
    [rep],
  );

  const rejectFact = useCallback(
    async (id: string): Promise<void> => {
      if (!rep) return;
      await rep.mutate.factReject({ factId: id });
    },
    [rep],
  );

  return {
    facts: data ?? [],
    loading,
    error,
    initialPullPending,
    retry,
    confirmFact,
    rejectFact,
  };
}
