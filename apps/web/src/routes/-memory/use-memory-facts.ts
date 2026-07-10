import { IDB_KEY, type SyncedFact, syncedFactSchema } from "@alfred/sync";
import { useCallback, useEffect, useState } from "react";
import type { ReadTransaction } from "replicache";
import type { AlfredReplicache } from "~/lib/replicache/client";
import { useReplicacheStatus } from "~/lib/replicache/context";

interface MemoryFactsState {
  facts: SyncedFact[];
  loading: boolean;
  error: string | null;
  initialPullPending: boolean;
  retry: () => void;
  confirmFact: (id: string) => Promise<void>;
  rejectFact: (id: string) => Promise<void>;
}

function sortFacts(a: SyncedFact, b: SyncedFact): number {
  return b.createdAt.localeCompare(a.createdAt);
}

/** Live, schema-validated facts used only by the memory review surface. */
export function useMemoryFacts(): MemoryFactsState {
  const { rep, loadError, pullError, initialPullPending, retry } = useReplicacheStatus();
  const [snapshot, setSnapshot] = useState<{
    rep: AlfredReplicache;
    facts: SyncedFact[];
  } | null>(null);

  useEffect(() => {
    if (!rep) {
      setSnapshot(null);
      return;
    }

    return rep.subscribe(
      async (tx: ReadTransaction) =>
        tx
          .scan({ prefix: IDB_KEY.FACT({}) })
          .values()
          .toArray(),
      (values) => {
        const parsed: SyncedFact[] = [];
        for (const value of values) {
          const result = syncedFactSchema.safeParse(value);
          if (result.success) parsed.push(result.data);
        }
        parsed.sort(sortFacts);
        setSnapshot({ rep, facts: parsed });
      },
    );
  }, [rep]);

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

  const facts = snapshot?.rep === rep ? snapshot.facts : null;
  const error = loadError ?? pullError;
  return {
    facts: facts ?? [],
    loading: !error && (facts === null || (facts.length === 0 && initialPullPending)),
    error,
    initialPullPending,
    retry,
    confirmFact,
    rejectFact,
  };
}
