import { SYNC_MODEL, type PreferenceValue, type SyncedPreference } from "@alfred/sync";
import { useCallback } from "react";
import type { ReadTransaction } from "replicache";
import { useReplicache } from "./context";
import { useReplicacheSubscription } from "./use-replicache-subscription";

export interface PreferenceMap {
  /** An absent key is unset. */
  values: Record<string, PreferenceValue>;
  loading: boolean;
  error: string | null;
  retry: () => void;
  setPref: (key: string, value: PreferenceValue) => Promise<void>;
}

const EMPTY_PREFERENCE_VALUES: Record<string, PreferenceValue> = {};

const noPreferences = (values: Record<string, PreferenceValue>) => Object.keys(values).length === 0;

/** The synced preferences (ADR-0012) as a key-value map. Domain hooks read their own keys. */
export function usePreferenceMap(): PreferenceMap {
  const rep = useReplicache();
  const query = useCallback((tx: ReadTransaction) => SYNC_MODEL.pref.scan(tx), []);

  const { data, loading, error, retry } = useReplicacheSubscription<
    SyncedPreference[],
    Record<string, PreferenceValue>
  >(
    query,
    useCallback((preferences: SyncedPreference[]) => {
      const next: Record<string, PreferenceValue> = {};

      for (const preference of preferences) {
        next[preference.key] = preference.value;
      }

      return next;
    }, []),
    { isEmpty: noPreferences },
  );

  const setPref = useCallback(
    async (key: string, value: PreferenceValue): Promise<void> => {
      if (!rep) return;
      await rep.mutate.prefSet({ key, value });
    },
    [rep],
  );

  return { values: data ?? EMPTY_PREFERENCE_VALUES, loading, error, retry, setPref };
}
