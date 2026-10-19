import { useEffect, useState } from "react";
import type { ReadTransaction, Replicache } from "replicache";
import type { ClientMutators } from "@alfred/sync";
import { useReplicacheStatus } from "./context";

/**
 * Subscribe to a Replicache query, with an optional `select` mapper. `null` until the first result.
 * A new client, query or mapper reads `null` until its own first result, so stale data does not flash.
 * Pass a module-level function or wrap `query` and `select` in `useCallback`. A new function on
 * each render resubscribes on each render and never shows a value.
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

  // Tagged with the client, query and mapper that produced it, so a new one reads `null` until
  // its first result, with no reset in the effect.
  const [snapshot, setSnapshot] = useState<{
    rep: Replicache<ClientMutators>;
    query: (tx: ReadTransaction) => Promise<T>;
    select: ((data: T) => U) | undefined;
    value: T | U;
  } | null>(null);

  useEffect(() => {
    if (!rep || !query) return;

    let cancelled = false;

    const unsubscribe = rep.subscribe(query, (data: T) => {
      if (cancelled) return;

      // With no `select`, the first overload makes U = T.
      setSnapshot({ rep, query, select, value: select ? select(data) : data });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [rep, query, select]);

  return snapshot?.rep === rep && snapshot.query === query && snapshot.select === select
    ? snapshot.value
    : null;
}
