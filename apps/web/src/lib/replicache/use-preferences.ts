import { IDB_KEY, type PreferenceValue, syncedPreferenceSchema } from "@alfred/sync";
import { useCallback, useEffect, useState } from "react";
import type { ReadTransaction } from "replicache";
import { useReplicacheStatus } from "./context";

export interface PreferenceMap {
  /** Live `key → value` map of the synced `pref/{key}` rows; absent keys are unset. */
  values: Record<string, unknown>;
  /** True once the first subscription result has arrived. */
  loaded: boolean;
  /** Optimistically write a preference row; the next server pull rebases it. */
  setPref: (key: string, value: PreferenceValue) => Promise<void>;
  loadError: string | null;
  retry: () => void;
}

/**
 * Live view of the synced preference table (`pref/{key}` rows, ADR-0012).
 *
 * Scans the prefix once, parses each row with {@link syncedPreferenceSchema},
 * and keeps a `key → value` map. Domain hooks (feature flags, briefing
 * schedule, …) interpret the values for their own surface; this hook owns only
 * the scan/parse/write machinery so it stays identical across those views.
 */
export function usePreferenceMap(): PreferenceMap {
  const { rep, loadError, retry } = useReplicacheStatus();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!rep) {
      setValues({});
      setLoaded(false);
      return;
    }
    const prefix = IDB_KEY.PREFERENCE({});
    return rep.subscribe(
      async (tx: ReadTransaction) => tx.scan({ prefix }).values().toArray(),
      (rows) => {
        const next: Record<string, unknown> = {};
        for (const row of rows) {
          const parsed = syncedPreferenceSchema.safeParse(row);
          if (parsed.success) next[parsed.data.key] = parsed.data.value;
        }
        setValues(next);
        setLoaded(true);
      },
    );
  }, [rep]);

  const setPref = useCallback(
    async (key: string, value: PreferenceValue): Promise<void> => {
      if (!rep) return;
      await rep.mutate.prefSet({ key, value });
    },
    [rep],
  );

  return { values, loaded, setPref, loadError, retry };
}
