/**
 * App theme system — provider + context hook.
 *
 * Three modes:
 *   - "system" (default) → tracks prefers-color-scheme; the `.app` element
 *     carries no data-app-theme attribute so the @media block in index.css
 *     resolves it.
 *   - "dark"  → forces data-app-theme="dark"
 *   - "light" → forces data-app-theme="light"
 *
 * Preference is persisted to localStorage under "app-theme" so a refresh
 * keeps the user's choice.
 *
 * Usage:
 *   <AppThemeProvider>
 *     <AppThemed>
 *       <AppThemeToggle />
 *       ...
 *     </AppThemed>
 *   </AppThemeProvider>
 *
 * Companion components (`AppThemed`, `AppThemeToggle`) live in their own
 * files so each module exports a single component.
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

/** The persisted theme choice — defined once, in the `app-theme` storage schema. */
export type AppThemeMode = LocalStorageValue<"app-theme">;
export type AppResolvedTheme = "dark" | "light";

export interface AppThemeContextValue {
  /** What the user has selected — may be "system". */
  mode: AppThemeMode;
  /** What's actually applied right now (resolved against prefers-color-scheme). */
  resolved: AppResolvedTheme;
  setMode: (mode: AppThemeMode) => void;
}

export const AppThemeContext = createContext<AppThemeContextValue | null>(null);

const STORAGE_KEY = "app-theme";

function readPersistedMode(): AppThemeMode {
  return getLocalStorageItem(STORAGE_KEY);
}

function getSystemPreference(): AppResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark"; // Alfred defaults to dark when nothing is detectable
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<AppThemeMode>(() => readPersistedMode());
  const [systemPref, setSystemPref] = useState<AppResolvedTheme>(() => getSystemPreference());

  // Track changes to the OS preference while the component is mounted.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setSystemPref(e.matches ? "dark" : "light");
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  const resolved: AppResolvedTheme = mode === "system" ? systemPref : mode;

  // Keep <html> in sync with the resolved theme so the UA canvas (scrollbars,
  // overscroll, the area behind `.app`) matches the app surface. The inline
  // script in index.html stamps this on first paint to avoid a FOUC; this
  // effect keeps it correct after a runtime toggle or OS change. `.app` itself
  // is stamped by <AppThemed>; the hex values mirror `--app-background`
  // (dark #0a0a0a / light #ffffff) in index.css.
  useEffect(() => {
    const el = document.documentElement;
    el.classList.toggle("dark", resolved === "dark");
    el.style.colorScheme = resolved;
    el.style.backgroundColor = resolved === "dark" ? "#0a0a0a" : "#ffffff";
  }, [resolved]);

  // Keep the user's choice in sync across tabs — the `storage` event fires in
  // every *other* tab when one writes, so a theme change here lands there too.
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
