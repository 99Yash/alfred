import type { FeatureFlagKey } from "@alfred/contracts";
import { IDB_KEY, syncedPreferenceSchema } from "@alfred/sync";
import { useCallback, useEffect, useState } from "react";
import type { ReadTransaction } from "replicache";
import { useReplicacheStatus } from "./context";

export interface FeatureFlagsState {
  /**
   * Effective on/off for a `feature.*` flag. UNSET resolves to ON — the same
   * default the server gates apply (`resolveFeatureFlags`), so the switch
   * shows exactly what will run.
   */
  isOn: (key: FeatureFlagKey) => boolean;
  /** Optimistically flip a flag; server confirms on the next pull. */
  setFlag: (key: FeatureFlagKey, enabled: boolean) => Promise<void>;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/** A stored `feature.*` value is OFF only on an explicit false; else ON. */
function valueIsOn(value: unknown): boolean {
  if (value === false || value === "false" || value === 0) return false;
  return true;
}

/**
 * Live view of the background-agent feature toggles (Settings → Features).
 *
 * Preferences sync as `pref/{key}` rows; we scan the prefix once and keep a
 * `key → value` map. Absence of a row means the user never touched that
 * switch, so it resolves to its server default (ON) via `isOn`.
 */
export function useFeatureFlags(): FeatureFlagsState {
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

  const isOn = useCallback(
    (key: FeatureFlagKey): boolean => (key in values ? valueIsOn(values[key]) : true),
    [values],
  );

  const setFlag = useCallback(
    async (key: FeatureFlagKey, enabled: boolean): Promise<void> => {
      if (!rep) return;
      await rep.mutate.prefSet({ key, value: enabled });
    },
    [rep],
  );

  return {
    isOn,
    setFlag,
    loading: !loaded && !loadError,
    error: loadError,
    retry,
  };
}
