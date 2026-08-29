import { SYNC_MODEL, type PreferenceValue, type SyncedPreference } from "@alfred/sync";
import { useCallback, useMemo } from "react";
import type { ReadTransaction } from "replicache";
import { useReplicacheStatus } from "./context";
import { useReplicacheSubscription } from "./use-replicache-subscription";

export interface PreferenceMap {
  /** Live `key → value` map of the synced `pref/{key}` rows; absent keys are unset. */
  values: Record<string, PreferenceValue>;
  /** True once the first subscription result has arrived. */
  loaded: boolean;
  /** Optimistically write a preference row; the next server pull rebases it. */
  setPref: (key: string, value: PreferenceValue) => Promise<void>;
  loadError: string | null;
  retry: () => void;
}

const EMPTY_PREFERENCE_VALUES: Record<string, PreferenceValue> = {};

/**
 * Live view of the synced preference table (`pref/{key}` rows, ADR-0012).
 *
 * Scans the model once and keeps a `key → value` map. The model owns row parsing.
 * and keeps a `key → value` map. Domain hooks (feature flags, briefing
 * schedule, …) interpret the values for their own surface; this hook owns only
 * the scan/parse/write machinery so it stays identical across those views.
 */
export function usePreferenceMap(): PreferenceMap {
  const { rep, loadError, retry } = useReplicacheStatus();
  const query = useCallback((tx: ReadTransaction) => SYNC_MODEL.pref.scan(tx), []);
  const rows = useReplicacheSubscription<SyncedPreference[], Record<string, PreferenceValue>>(
    query,
    useCallback((preferences: SyncedPreference[]) => {
      const next: Record<string, PreferenceValue> = {};
      for (const preference of preferences) {
        next[preference.key] = preference.value;
      }
      return next;
    }, []),
  );

  const { values, loaded } = useMemo(() => {
    if (rows === null) return { values: EMPTY_PREFERENCE_VALUES, loaded: false };
    return { values: rows, loaded: true };
  }, [rows]);

  const setPref = useCallback(
    async (key: string, value: PreferenceValue): Promise<void> => {
      if (!rep) return;
      await rep.mutate.prefSet({ key, value });
    },
    [rep],
  );

  return { values, loaded, setPref, loadError, retry };
}
