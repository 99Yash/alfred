/**
 * Visitors-now theme system — provider + context hook.
 *
 * Three modes:
 *   - "system" (default) → tracks prefers-color-scheme; the `.vs` element
 *     carries no data-vs-theme attribute so the @media block in index.css
 *     resolves it.
 *   - "dark"  → forces data-vs-theme="dark"
 *   - "light" → forces data-vs-theme="light"
 *
 * Preference is persisted to localStorage under "vs-theme" so a refresh
 * keeps the user's choice.
 *
 * Usage:
 *   <VsThemeProvider>
 *     <VsThemed>
 *       <VsThemeToggle />
 *       ...
 *     </VsThemed>
 *   </VsThemeProvider>
 *
 * Companion components (`VsThemed`, `VsThemeToggle`) live in their own
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

export type VsThemeMode = "system" | "dark" | "light";
export type VsResolvedTheme = "dark" | "light";

export interface VsThemeContextValue {
  /** What the user has selected — may be "system". */
  mode: VsThemeMode;
  /** What's actually applied right now (resolved against prefers-color-scheme). */
  resolved: VsResolvedTheme;
  setMode: (mode: VsThemeMode) => void;
}

export const VsThemeContext = createContext<VsThemeContextValue | null>(null);

const STORAGE_KEY = "vs-theme";

function readPersistedMode(): VsThemeMode {
  if (typeof window === "undefined") return "system";
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "dark" || raw === "light" || raw === "system") return raw;
  } catch {
    /* localStorage might be denied in some contexts; just fall through. */
  }
  return "system";
}

function getSystemPreference(): VsResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark"; // Alfred defaults to dark when nothing is detectable
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function VsThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<VsThemeMode>(() => readPersistedMode());
  const [systemPref, setSystemPref] = useState<VsResolvedTheme>(() => getSystemPreference());

  // Track changes to the OS preference while the component is mounted.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setSystemPref(e.matches ? "dark" : "light");
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  const resolved: VsResolvedTheme = mode === "system" ? systemPref : mode;

  const setMode = useCallback((next: VsThemeMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo<VsThemeContextValue>(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);

  return <VsThemeContext.Provider value={value}>{children}</VsThemeContext.Provider>;
}

export function useVsTheme(): VsThemeContextValue {
  const ctx = use(VsThemeContext);
  if (!ctx) {
    throw new Error("useVsTheme must be called inside a <VsThemeProvider>.");
  }
  return ctx;
}
