import { useCallback, useEffect, useState } from "react";
import { getLocalStorageItem, setLocalStorageItem } from "~/lib/storage/storage";

const WIDTH_KEY = "alfred:sidebar-width";
const MINIMIZED_KEY = "alfred:sidebar-minimized";
const GROUPS_KEY = "alfred:sidebar-collapsed-groups";

export function usePersistentSidebarMinimized(fallback: boolean) {
  const [value, setValue] = useState<boolean>(() => getLocalStorageItem(MINIMIZED_KEY, fallback));
  useEffect(() => {
    setLocalStorageItem(MINIMIZED_KEY, value);
  }, [value]);
  return [value, setValue] as const;
}

export function usePersistentSidebarWidth(fallback: number, min: number, max: number) {
  const clamp = (value: number) => Math.min(max, Math.max(min, value));
  const [value, setValue] = useState<number>(() => {
    const stored = getLocalStorageItem(WIDTH_KEY, fallback);
    return Number.isFinite(stored) && stored > 0 ? clamp(stored) : fallback;
  });
  useEffect(() => {
    setLocalStorageItem(WIDTH_KEY, value);
  }, [value]);
  return [value, setValue] as const;
}

export function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(getLocalStorageItem(GROUPS_KEY)),
  );
  const toggle = useCallback((label: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      setLocalStorageItem(GROUPS_KEY, [...next]);
      return next;
    });
  }, []);
  return [collapsed, toggle] as const;
}
