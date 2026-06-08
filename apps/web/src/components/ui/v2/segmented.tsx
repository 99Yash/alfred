/**
 * App-grammar segmented control.
 *
 * A pill track containing tab cells. The active cell fills with the
 * surface color (so it looks "lifted out" of the track), while the
 * inactive cells are transparent against the track background. Used for
 * the communication-channel selector in /preview/settings.
 *
 * Built on `@radix-ui/react-tabs` so we get roving tabindex + arrow
 * key navigation + Home/End cycling for free.
 */

import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export interface AppSegmentedItem<T extends string = string> {
  value: T;
  label: ReactNode;
  /** Optional leading icon. */
  icon?: ReactNode;
  disabled?: boolean;
}

interface AppSegmentedProps<T extends string = string> {
  value: T;
  onValueChange: (value: T) => void;
  items: ReadonlyArray<AppSegmentedItem<T>>;
  /** ARIA label for the tablist. */
  label?: string;
  disabled?: boolean;
  className?: string;
  /**
   * `"default"` — opaque surface track (settings, anywhere on chrome).
   * `"glass"` — translucent, blurred track that lets a busy backdrop
   * (e.g. the rail's weather video) bleed through while staying legible.
   * The active cell becomes a solid dark chip so its label reads against
   * whatever sky is behind.
   */
  variant?: "default" | "glass";
}

export function AppSegmented<T extends string = string>({
  value,
  onValueChange,
  items,
  label = "Options",
  disabled = false,
  className,
  variant = "default",
}: AppSegmentedProps<T>) {
  const glass = variant === "glass";
  return (
    <TabsPrimitive.Root value={value} onValueChange={(next) => onValueChange(next as T)}>
      <TabsPrimitive.List
        aria-label={label}
        className={cn(
          "inline-flex items-center gap-1 p-1 rounded-xl",
          glass
            ? // The glass track always floats over the rail's dark weather
              // video, so its surface colors are theme-independent literals —
              // app-bg/app-fg tokens invert in light mode and would wash the
              // track (and its active chip) out to white-on-white.
              "bg-white/[0.12] ring-1 ring-white/15 backdrop-blur-xl backdrop-saturate-150 shadow-[0_1px_12px_rgba(0,0,0,0.18)]"
            : "bg-app-bg-2 ring-1 ring-app-bg-3",
          className,
        )}
      >
        {items.map((item) => (
          <TabsPrimitive.Trigger
            key={item.value}
            value={item.value}
            disabled={disabled || item.disabled}
            className={cn(
              "inline-flex items-center gap-1.5 h-7 px-3 rounded-lg",
              "text-xs font-medium whitespace-nowrap",
              "transition-all duration-150",
              "app-press",
              glass
                ? cn(
                    "outline-none focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
                    /* off state — white-based so it reads over the sky video */
                    "text-white/70 hover:text-white",
                    /* on state — solid dark glass chip over the sky video.
                     * Fixed dark literal (matches the rail's scrim), not
                     * bg-app-bg-1 which flips to white in light mode. */
                    "data-[state=active]:bg-[rgba(7,17,31,0.72)] data-[state=active]:text-white",
                    "data-[state=active]:ring-1 data-[state=active]:ring-white/10",
                    "data-[state=active]:shadow-[var(--app-shadow-elevated)]",
                    "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-white/70",
                  )
                : cn(
                    "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-bg-2",
                    /* off state */
                    "text-app-fg-3 hover:text-app-fg-4",
                    /* on state */
                    "data-[state=active]:bg-app-bg-1 data-[state=active]:text-app-fg-4",
                    "data-[state=active]:shadow-[var(--app-shadow-elevated)]",
                    /* disabled */
                    "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-app-fg-3",
                  ),
            )}
          >
            {item.icon ? <span className="inline-flex shrink-0">{item.icon}</span> : null}
            {item.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {/* Radix auto-wires each Trigger's `aria-controls` to a panel id. This
       * control selects a value and lets each call site render its own content
       * (or none, for pure value-pickers), so without a matching panel every
       * trigger points `aria-controls` at a non-existent id — failing the
       * `aria-valid-attr-value` a11y audit. Mount an empty, always-hidden panel
       * per value so the reference resolves; it carries no content and takes no
       * space, so there's no visual or layout effect anywhere it's used. */}
      {items.map((item) => (
        <TabsPrimitive.Content key={item.value} value={item.value} forceMount className="hidden" />
      ))}
    </TabsPrimitive.Root>
  );
}
