import { useCallback, useState } from "react";
import { getLocalStorageItem, setLocalStorageItem } from "~/lib/storage/storage";
import type { ChatModelTier } from "@alfred/contracts";

/** Auto/Deep tier in the typed `alfred.chat.tier` localStorage key, sticky across reloads and threads. */
export function useModelTier(): [ChatModelTier, (tier: ChatModelTier) => void] {
  const [tier, setTierState] = useState<ChatModelTier>(() =>
    getLocalStorageItem("alfred.chat.tier"),
  );

  const setTier = useCallback((next: ChatModelTier) => {
    setTierState(next);
    setLocalStorageItem("alfred.chat.tier", next);
  }, []);

  return [tier, setTier];
}
