import { useEffect, useState } from "react";
import type { ReadTransaction } from "replicache";
import { useReplicache } from "./context";

/**
 * Subscribe to a Replicache query. Returns `undefined` on the first render
 * before the subscription fires — components must handle this gracefully.
 *
 * Pass a stable `query` function (defined outside the component or wrapped in
 * `useCallback`) to avoid resubscribe storms on every render.
 */
export function useSubscribe<T>(query: (tx: ReadTransaction) => Promise<T>): T | undefined {
  const rep = useReplicache();
  const [state, setState] = useState<T | undefined>(undefined);

  useEffect(() => {
    if (!rep) {
      setState(undefined);
      return;
    }
    // Wrap in updater form so a function-valued query result isn't treated
    // as a state-updater by React.
    return rep.subscribe(query, (value) => setState(() => value));
  }, [rep, query]);

  return state;
}
