import type { FeatureFlagKey } from "@alfred/contracts";
import { useCallback } from "react";
import { usePreferenceMap } from "./use-preferences";

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
  const { values, loaded, setPref, loadError, retry } = usePreferenceMap();

  const isOn = useCallback(
    (key: FeatureFlagKey): boolean => (key in values ? valueIsOn(values[key]) : true),
    [values],
  );

  const setFlag = useCallback(
    (key: FeatureFlagKey, enabled: boolean): Promise<void> => setPref(key, enabled),
    [setPref],
  );

  return {
    isOn,
    setFlag,
    loading: !loaded && !loadError,
    error: loadError,
    retry,
  };
}
