import { useEffect, useState } from "react";
import type { ReadTransaction, Replicache } from "replicache";
import type { ClientMutators } from "@alfred/sync";
import { useReplicacheStatus } from "./context";

export interface ReplicacheQueryState<U> {
  /** `undefined` until the first result for this client, query and mapper. `null` is a result. */
  data: U | undefined;
  /** `query !== null && error === null && (data === undefined || (isEmpty(data) && initialPullPending))` */
  loading: boolean;
  /** `loadError ?? pullError`. Rows may still be present: show them with the error, do not hide them. */
  error: string | null;
  initialPullPending: boolean;
  retry: () => void;
}

export interface ReplicacheQueryOptions<U> {
  /** Default: `null`, a zero-length array, or a zero-size `Map`. */
  isEmpty?: (data: U) => boolean;
}

function isEmptyResult(data: unknown): boolean {
  return (
    data === null ||
    (Array.isArray(data) && data.length === 0) ||
    (data instanceof Map && data.size === 0)
  );
}

/**
 * Subscribe to a Replicache query, with an optional `select` mapper. This is the one place that
 * calls `rep.subscribe` and the one loading rule: an empty result reads as loading until the
 * client's first pull succeeds, so a cold store never shows "empty".
 * A new client, query or mapper reads `undefined` until its own first result, so stale data does
 * not flash. Pass a module-level function or wrap `query` and `select` in `useCallback`. A new
 * function on each render resubscribes on each render and never shows a value.
 */
export function useReplicacheSubscription<T extends {} | null>(
  query: ((tx: ReadTransaction) => Promise<T>) | null,
  options?: ReplicacheQueryOptions<T>,
): ReplicacheQueryState<T>;
export function useReplicacheSubscription<T, U extends {} | null>(
  query: ((tx: ReadTransaction) => Promise<T>) | null,
  select: (data: T) => U,
  options?: ReplicacheQueryOptions<U>,
): ReplicacheQueryState<U>;
export function useReplicacheSubscription<T, U>(
  query: ((tx: ReadTransaction) => Promise<T>) | null,
  selectOrOptions?: ((data: T) => U) | ReplicacheQueryOptions<T | U>,
  maybeOptions?: ReplicacheQueryOptions<T | U>,
): ReplicacheQueryState<T | U> {
  const { rep, loadError, pullError, initialPullPending, retry } = useReplicacheStatus();
  // The overloads put a function or an options object second.
  const select = selectOrOptions instanceof Function ? selectOrOptions : undefined;
  const options = selectOrOptions instanceof Function ? maybeOptions : selectOrOptions;

  // Tagged with the client, query and mapper that produced it, so a new one reads `undefined`
  // until its first result, with no reset in the effect.
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

  const data =
    snapshot?.rep === rep && snapshot.query === query && snapshot.select === select
      ? snapshot.value
      : undefined;

  const error = loadError ?? pullError;
  const isEmpty = options?.isEmpty ?? isEmptyResult;

  return {
    data,
    loading:
      query !== null &&
      error === null &&
      (data === undefined || (isEmpty(data) && initialPullPending)),
    error,
    initialPullPending,
    retry,
  };
}
