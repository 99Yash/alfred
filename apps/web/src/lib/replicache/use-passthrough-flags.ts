import {
  isPassthroughPreferenceOn,
  PASSTHROUGH_PREFERENCE_KEYS,
  type SupportedIntegrationSlug,
} from "@alfred/contracts";
import { useCallback } from "react";
import { usePreferenceMap } from "./use-preferences";

export interface PassthroughFlagsState {
  /**
   * Effective on/off for an integration's general read-only passthrough tool.
   * **Default OFF** (ADR-0074): an absent preference row resolves to OFF, the
   * inverse of the background-agent `feature.*` flags (UNSET = ON). The switch
   * must not reuse `useFeatureFlags().isOn`, whose default would silently arm a
   * security-sensitive tier the user never enabled.
   */
  isOn: (slug: SupportedIntegrationSlug) => boolean;
  /** Optimistically flip a passthrough toggle; the server confirms on next pull. */
  setEnabled: (slug: SupportedIntegrationSlug, enabled: boolean) => Promise<void>;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/**
 * Live view of the per-integration general-passthrough toggles
 * (Settings → Features). Reads the same synced `pref/{key}` rows as
 * {@link useFeatureFlags} but resolves them through
 * {@link isPassthroughPreferenceOn} so the default is OFF — a gate bug in this
 * read-only tier must be killable per-integration without a deploy, and a tool
 * the user never enabled must never appear armed.
 */
export function usePassthroughFlags(): PassthroughFlagsState {
  const { values, loaded, setPref, loadError, retry } = usePreferenceMap();

  const isOn = useCallback(
    (slug: SupportedIntegrationSlug): boolean =>
      isPassthroughPreferenceOn(values[PASSTHROUGH_PREFERENCE_KEYS[slug]]),
    [values],
  );

  const setEnabled = useCallback(
    (slug: SupportedIntegrationSlug, enabled: boolean): Promise<void> =>
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
