/**
 * `<AppThemeToggle>` — 3-state cycle: system → light → dark → system.
 *
 * Renders icon-only at h-8, suitable for a header corner. Icons are
 * inlined so the file stays a single-component module.
 */

import { cn } from "~/lib/utils";
import { useAppTheme, type AppThemeMode } from "./theme";

export function AppThemeToggle({ className }: { className?: string }) {
  const { mode, setMode } = useAppTheme();
  const next: AppThemeMode = mode === "system" ? "light" : mode === "light" ? "dark" : "system";
  const label =
    mode === "system" ? "Theme: system" : mode === "light" ? "Theme: light" : "Theme: dark";

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => setMode(next)}
      className={cn(
        "app-press inline-flex size-8 items-center justify-center rounded-lg",
        "bg-app-bg-1 text-app-fg-3 hover:text-app-fg-4",
        "shadow-[var(--app-shadow-elevated)] hover:shadow-[var(--app-shadow-elevated-hover)]",
        "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-app-background",
        className,
      )}
    >
      {mode === "system" ? (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
          <rect
            x="1.5"
            y="2.5"
            width="11"
            height="7.5"
            rx="1.25"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <path
            d="M5 12.5h4M7 10v2.5"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      ) : mode === "light" ? (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
          <circle cx="7" cy="7" r="2.5" stroke="currentColor" strokeWidth="1.2" />
          <path
            d="M7 1.5v1.5M7 11v1.5M12.5 7h-1.5M3 7H1.5M11 3l-1 1M4 10l-1 1M11 11l-1-1M4 4L3 3"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
          <path
            d="M11.5 8.5A4.5 4.5 0 015.5 2.5a4.5 4.5 0 106 6z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}
