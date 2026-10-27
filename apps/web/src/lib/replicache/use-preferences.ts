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
  /**
   * Pass-through of `ReplicacheQueryState.hasData` (see the helper for the formula).
   * The settings sections show their error panel only when this is false,
   * and their controls with a cached notice otherwise.
   */
  hasData: boolean;
  retry: () => void;
  setPref: (key: string, value: PreferenceValue) => Promise<void>;
}

const EMPTY_PREFERENCE_VALUES: Record<string, PreferenceValue> = {};

const noPreferences = (values: Record<string, PreferenceValue>) => Object.keys(values).length === 0;

/** The synced preferences (ADR-0012) as a key-value map. Domain hooks read their own keys. */
export function usePreferenceMap(): PreferenceMap {
  const rep = useReplicache();
  const query = useCallback((tx: ReadTransaction) => SYNC_MODEL.pref.scan(tx), []);

  const { data, loading, error, hasData, retry } = useReplicacheSubscription<
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

  return { values: data ?? EMPTY_PREFERENCE_VALUES, loading, error, hasData, retry, setPref };
}
