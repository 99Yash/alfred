import { useCallback, useState } from "react";
import { getLocalStorageItem, setLocalStorageItem } from "~/lib/storage/storage";
import type { ChatTier } from "../model-tier-picker";

/**
 * Model-tier selection (Auto vs Deep) persisted to localStorage, so the choice
 * is sticky across reloads and thread switches. Single-user, so this is a plain
 * local preference — no synced user-row field yet (a multi-device follow-up).
 * Backed by the typed `alfred.chat.tier` key in the storage registry, so the
 * value is schema-validated on read/write and can't drift from the tier union.
 */
export function useModelTier(): [ChatTier, (tier: ChatTier) => void] {
  const [tier, setTierState] = useState<ChatTier>(() => getLocalStorageItem("alfred.chat.tier"));
  const setTier = useCallback((next: ChatTier) => {
    setTierState(next);
    setLocalStorageItem("alfred.chat.tier", next);
  }, []);
  return [tier, setTier];
}
