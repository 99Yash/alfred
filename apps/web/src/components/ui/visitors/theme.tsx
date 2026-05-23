/**
 * Visitors-now theme system.
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
 *     <div className="vs ...">
 *       <VsThemeToggle />
 *       ...
 *     </div>
 *   </VsThemeProvider>
 *
 * The `<VsThemed>` wrapper combines the .vs class + correct data-vs-theme
 * attribute in one element, so callers don't have to wire data attributes
 * themselves.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "~/lib/utils";

export type VsThemeMode = "system" | "dark" | "light";
type ResolvedTheme = "dark" | "light";

interface VsThemeContextValue {
  /** What the user has selected — may be "system". */
  mode: VsThemeMode;
  /** What's actually applied right now (resolved against prefers-color-scheme). */
  resolved: ResolvedTheme;
  setMode: (mode: VsThemeMode) => void;
}

const VsThemeContext = createContext<VsThemeContextValue | null>(null);

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

function getSystemPreference(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark"; // Alfred defaults to dark when nothing is detectable
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function VsThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<VsThemeMode>(() => readPersistedMode());
  const [systemPref, setSystemPref] = useState<ResolvedTheme>(() => getSystemPreference());

  // Track changes to the OS preference while the component is mounted.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setSystemPref(e.matches ? "dark" : "light");
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  const resolved: ResolvedTheme = mode === "system" ? systemPref : mode;

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
  const ctx = useContext(VsThemeContext);
  if (!ctx) {
    throw new Error("useVsTheme must be called inside a <VsThemeProvider>.");
  }
  return ctx;
}

/**
 * A `<div>` (by default) that combines the `.vs` opt-in class with the
 * correct `data-vs-theme` attribute. Use this as the outermost element
 * of a visitors-now-grammar subtree.
 *
 * When `mode === "system"` no attribute is written, so the @media block
 * in index.css does the resolution.
 */
export function VsThemed({
  as: As = "div",
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { as?: "div" | "main" | "section" | "article" }) {
  const ctx = useContext(VsThemeContext);
  // If no provider is mounted, fall back to .vs with no attribute — which
  // means "track system preference" via the @media block.
  const dataTheme = ctx?.mode === "dark" || ctx?.mode === "light" ? ctx.mode : undefined;
  const Comp = As as React.ElementType;
  return (
    <Comp className={cn("vs", className)} data-vs-theme={dataTheme} {...rest}>
      {children}
    </Comp>
  );
}

/**
 * Small 3-state toggle button: system → light → dark → system.
 * Renders icon-only at h-8, suitable for a header corner.
 */
export function VsThemeToggle({ className }: { className?: string }) {
  const { mode, setMode } = useVsTheme();
  const next: VsThemeMode = mode === "system" ? "light" : mode === "light" ? "dark" : "system";
  const label =
    mode === "system" ? "Theme: system" : mode === "light" ? "Theme: light" : "Theme: dark";

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => setMode(next)}
      className={cn(
        "vs-press inline-flex items-center justify-center size-8 rounded-lg",
        "bg-vs-bg-1 text-vs-fg-3 hover:text-vs-fg-4",
        "shadow-[var(--vs-shadow-elevated)] hover:shadow-[var(--vs-shadow-elevated-hover)]",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-vs-background",
        className,
      )}
    >
      {mode === "system" ? <SystemIcon /> : mode === "light" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="2.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M7 1.5v1.5M7 11v1.5M12.5 7h-1.5M3 7H1.5M11 3l-1 1M4 10l-1 1M11 11l-1-1M4 4L3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M11.5 8.5A4.5 4.5 0 015.5 2.5a4.5 4.5 0 106 6z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="11" height="7.5" rx="1.25" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5 12.5h4M7 10v2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
