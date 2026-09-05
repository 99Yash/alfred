import { isFeatureFlagOn, type FeatureFlagKey } from "@alfred/contracts";
import { useCallback } from "react";
import { usePreferenceMap } from "./use-preferences";

export interface FeatureFlagsState {
  /**
   * Effective on/off for a `feature.*` flag. UNSET resolves to the per-key
   * default in `FEATURE_FLAG_DEFAULTS` — the same resolver the server gates
   * apply (`resolveFeatureFlags`), so the switch shows exactly what will run.
   */
  isOn: (key: FeatureFlagKey) => boolean;
  /** Optimistically flip a flag; server confirms on the next pull. */
  setFlag: (key: FeatureFlagKey, enabled: boolean) => Promise<void>;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/**
 * Live view of the background-agent feature toggles (Settings → Features).
 *
 * Preferences sync as `pref/{key}` rows; we scan the prefix once and keep a
 * `key → value` map via {@link usePreferenceMap}, which is built on the
 * shared {@link useReplicacheSubscription} helper. Absence of a row means
 * the user never touched that switch, so it resolves to its server default
 * (`FEATURE_FLAG_DEFAULTS`) via `isOn`.
 */
export function useFeatureFlags(): FeatureFlagsState {
  const { values, loaded, setPref, loadError, retry } = usePreferenceMap();

  const isOn = useCallback(
    (key: FeatureFlagKey): boolean => isFeatureFlagOn(key, values[key]),
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
