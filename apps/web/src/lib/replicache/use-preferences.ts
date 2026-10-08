import { SYNC_MODEL, type PreferenceValue, type SyncedPreference } from "@alfred/sync";
import { useCallback, useMemo } from "react";
import type { ReadTransaction } from "replicache";
import { useReplicacheStatus } from "./context";
import { useReplicacheSubscription } from "./use-replicache-subscription";

export interface PreferenceMap {
  /** An absent key is unset. */
  values: Record<string, PreferenceValue>;
  loaded: boolean;
  setPref: (key: string, value: PreferenceValue) => Promise<void>;
  loadError: string | null;
  retry: () => void;
}

const EMPTY_PREFERENCE_VALUES: Record<string, PreferenceValue> = {};

/** The synced preferences (ADR-0012) as a key-value map. Domain hooks read their own keys. */
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
