import {
  isPassthroughPreferenceOn,
  PASSTHROUGH_PREFERENCE_KEYS,
  type SupportedPassthroughSlug,
} from "@alfred/contracts";
import { useCallback } from "react";
import { usePreferenceMap } from "./use-preferences";

export interface PassthroughFlagsState {
  /**
   * Unset means off (ADR-0074). Do not use `useFeatureFlags().isOn`: its default
   * would arm a tier the user never enabled.
   */
  isOn: (slug: SupportedPassthroughSlug) => boolean;
  setEnabled: (slug: SupportedPassthroughSlug, enabled: boolean) => Promise<void>;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/** Per-integration passthrough toggles, default off. */
export function usePassthroughFlags(): PassthroughFlagsState {
  const { values, loaded, setPref, loadError, retry } = usePreferenceMap();

  const isOn = useCallback(
    (slug: SupportedPassthroughSlug): boolean =>
      isPassthroughPreferenceOn(values[PASSTHROUGH_PREFERENCE_KEYS[slug]]),
    [values],
  );

  const setEnabled = useCallback(
    (slug: SupportedPassthroughSlug, enabled: boolean): Promise<void> =>
      setPref(PASSTHROUGH_PREFERENCE_KEYS[slug], enabled),
    [setPref],
  );

  return {
    isOn,
    setEnabled,
    loading: !loaded && !loadError,
    error: loadError,
    retry,
  };
}
