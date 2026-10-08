/**
 * App theme provider. "system" (default) sets no `data-app-theme`, so the
 * index.css media query decides; "dark" and "light" force it.
 */

import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  getLocalStorageItem,
  setLocalStorageItem,
  subscribeToStorage,
  type LocalStorageValue,
} from "~/lib/storage/storage";

export type AppThemeMode = LocalStorageValue<"app-theme">;

export type AppResolvedTheme = "dark" | "light";

export interface AppThemeContextValue {
  /** May be "system". */
  mode: AppThemeMode;
  /** Applied theme, with "system" resolved. */
  resolved: AppResolvedTheme;
  setMode: (mode: AppThemeMode) => void;
}

export const AppThemeContext = createContext<AppThemeContextValue | null>(null);

const STORAGE_KEY = "app-theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** `null` without a window (SSR) or `matchMedia`, so each caller picks its own fallback. */
function safeMatchMedia(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;

  return window.matchMedia(query);
}

function readPersistedMode(): AppThemeMode {
  return getLocalStorageItem(STORAGE_KEY);
}

function getSystemPreference(): AppResolvedTheme {
  // Dark when nothing is detectable.
  return safeMatchMedia(DARK_QUERY)?.matches === false ? "light" : "dark";
}

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<AppThemeMode>(() => readPersistedMode());
  const [systemPref, setSystemPref] = useState<AppResolvedTheme>(() => getSystemPreference());

  useEffect(() => {
    const mql = safeMatchMedia(DARK_QUERY);

    if (!mql) return;
    const handler = (e: MediaQueryListEvent) => setSystemPref(e.matches ? "dark" : "light");
    mql.addEventListener("change", handler);

    return () => mql.removeEventListener("change", handler);
  }, []);

  const resolved: AppResolvedTheme = mode === "system" ? systemPref : mode;

  // Sync <html> so scrollbars and overscroll match. index.html stamps first paint;
  // this covers later changes. Hex values mirror `--app-background` in index.css.
  useEffect(() => {
    const el = document.documentElement;
    el.classList.toggle("dark", resolved === "dark");
    el.style.colorScheme = resolved;
    el.style.backgroundColor = resolved === "dark" ? "#0a0a0a" : "#ffffff";
  }, [resolved]);

  // The `storage` event syncs a change made in another tab.
  useEffect(() => subscribeToStorage(STORAGE_KEY, setModeState), []);

  const setMode = useCallback((next: AppThemeMode) => {
    setModeState(next);
    setLocalStorageItem(STORAGE_KEY, next);
  }, []);

  const value = useMemo<AppThemeContextValue>(
    () => ({ mode, resolved, setMode }),
    [mode, resolved, setMode],
  );

  return <AppThemeContext.Provider value={value}>{children}</AppThemeContext.Provider>;
}

export function useAppTheme(): AppThemeContextValue {
  const ctx = use(AppThemeContext);

  if (!ctx) {
    throw new Error("useAppTheme must be called inside a <AppThemeProvider>.");
  }

  return ctx;
}
