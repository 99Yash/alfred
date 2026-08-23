import { useEffect, useState } from "react";
import type { ReadTransaction } from "replicache";
import type { AlfredReplicache } from "./client";
import { useReplicacheStatus } from "./context";

const identity = <T>(value: T): T => value;

/**
 * Shared Replicache subscription helper.
 *
 * It owns the subscribe / snapshot / cleanup lifecycle so per-entity hooks
 * do not copy that boilerplate. The caller provides the query (what to read
 * in a `ReadTransaction`) and an optional mapper (how to turn the raw rows
 * into the shape the component wants). The hook subscribes when `rep` is
 * ready, maps each result, and tears the subscription down on unmount or
 * when any dependency changes.
 *
 * The snapshot is guarded by `rep` identity so a client swap (user change)
 * discards the stale snapshot together with its client. When the query
 * reference changes (for example a new prefix for a different date) the
 * snapshot is cleared before the new subscription fires, so the caller does
 * not flash stale data for the previous key.
 *
 * The `query` and `select` callbacks must be stable (wrap them in
 * `useCallback` at the call site) — a new reference correctly resubscribes,
 * but a per-render recreation would resubscribe on every render.
 */
export function useReplicacheSubscription<T, U = T>(
  query: ((tx: ReadTransaction) => Promise<T>) | null,
  select?: (data: T) => U,
): U | null {
  const { rep } = useReplicacheStatus();
  const [snapshot, setSnapshot] = useState<{
    rep: AlfredReplicache;
    value: U;
  } | null>(null);

  // When `select` is absent the identity is stable and never forces a
  // resubscribe; when it is present the caller must stabilize it.
  const mapper = (select ?? identity) as (data: T) => U;

  useEffect(() => {
    if (!rep || !query) {
      setSnapshot(null);
      return;
    }

    // Discard stale snapshot for a new query/rep before the first fire.
    setSnapshot(null);

    let cancelled = false;
    const unsubscribe = rep.subscribe(query, (data: T) => {
      if (cancelled) return;
      setSnapshot({ rep, value: mapper(data) });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [rep, query, mapper]);

  return snapshot?.rep === rep ? snapshot.value : null;
}
