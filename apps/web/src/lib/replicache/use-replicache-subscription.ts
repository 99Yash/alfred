import { useEffect, useState } from "react";
import type { ReadTransaction, Replicache } from "replicache";
import type { ClientMutators } from "@alfred/sync";
import { useReplicacheStatus } from "./context";

/**
 * Subscribe to a Replicache query, with an optional `select` mapper. `null` until the first result.
 * A new client or query clears the old value first, so stale data does not flash.
 * Wrap `query` and `select` in `useCallback`, or it resubscribes on every render.
 */
export function useReplicacheSubscription<T>(
  query: ((tx: ReadTransaction) => Promise<T>) | null,
): T | null;
export function useReplicacheSubscription<T, U>(
  query: ((tx: ReadTransaction) => Promise<T>) | null,
  select: (data: T) => U,
): U | null;
export function useReplicacheSubscription<T, U>(
  query: ((tx: ReadTransaction) => Promise<T>) | null,
  select?: (data: T) => U,
): (T | U) | null {
  const { rep } = useReplicacheStatus();

  const [snapshot, setSnapshot] = useState<{
    rep: Replicache<ClientMutators>;
    value: T | U;
  } | null>(null);

  useEffect(() => {
    if (!rep || !query) {
      setSnapshot(null);

      return;
    }

    setSnapshot(null);

    let cancelled = false;

    const unsubscribe = rep.subscribe(query, (data: T) => {
      if (cancelled) return;

      if (select) {
        setSnapshot({ rep, value: select(data) });
      } else {
        // With no `select`, the first overload makes U = T.
        setSnapshot({ rep, value: data });
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [rep, query, select]);

  return snapshot?.rep === rep ? snapshot.value : null;
}
