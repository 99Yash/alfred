import { isFeatureFlagOn, type FeatureFlagKey } from "@alfred/contracts";
import { useCallback } from "react";
import { usePreferenceMap } from "./use-preferences";

export interface FeatureFlagsState {
  /** Unset means the `FEATURE_FLAG_DEFAULTS` value, as on the server. */
  isOn: (key: FeatureFlagKey) => boolean;
  setFlag: (key: FeatureFlagKey, enabled: boolean) => Promise<void>;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/** Background-agent feature toggles (Settings, Features). */
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
