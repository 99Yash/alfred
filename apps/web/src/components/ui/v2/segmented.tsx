/** Segmented control on Radix tabs (roving tabindex and arrow keys). The active cell looks lifted. */

import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export interface AppSegmentedItem<T extends string = string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode | undefined;
  disabled?: boolean | undefined;
}

interface AppSegmentedProps<T extends string = string> {
  value: T;
  onValueChange: (value: T) => void;
  items: ReadonlyArray<AppSegmentedItem<T>>;
  label?: string | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
  /** `glass`: translucent track for a busy backdrop such as the weather video. */
  variant?: "default" | "glass" | undefined;
  /**
   * `fill`: equal-width cells that span the container, and one thumb that slides to the
   * active cell. `inline`: cells as wide as their labels, each active cell lifts in place.
   */
  layout?: "inline" | "fill" | undefined;
}

/** The track inset (`p-1`) on each side. The thumb width subtracts both. */
const TRACK_INSET = "0.25rem";

export function AppSegmented<T extends string = string>({
  value,
  onValueChange,
  items,
  label = "Options",
  disabled = false,
  className,
  variant = "default",
  layout = "inline",
}: AppSegmentedProps<T>) {
  const glass = variant === "glass";
  const fill = layout === "fill";
  const activeIndex = items.findIndex((item) => item.value === value);

  // Radix emits the value of a rendered item, so the lookup always finds it.
  const emit = (next: string) => {
    const item = items.find((candidate) => candidate.value === next);

    if (item) onValueChange(item.value);
  };

  return (
    <TabsPrimitive.Root value={value} onValueChange={emit}>
      <TabsPrimitive.List
        aria-label={label}
        // Both pills, so the active chip follows the track's curve at any tier value.
        className={cn(
          "rounded-full p-1",
          fill
            ? "relative grid w-full auto-cols-fr grid-flow-col"
            : "inline-flex items-center gap-1",
          glass
            ? // The rail's `.app-media` scope gives these tokens their dark values over the video.
              // A dark track under a light thumb: the thumb reads as the lit, raised layer.
              "bg-[rgba(7,17,31,0.32)] shadow-[0_1px_12px_rgba(0,0,0,0.18)] ring-1 ring-app-bg-a3 backdrop-blur-xl backdrop-saturate-150"
            : "bg-app-bg-2 ring-1 ring-app-bg-3",
          className,
        )}
      >
        {fill && activeIndex >= 0 ? (
          // One thumb that slides, so the eye follows the selection from the old cell to the new.
          // The transition starts from the current transform, so a fast second click retargets it.
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-y-1 left-1 rounded-full",
              "transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
              glass
                ? "bg-[rgba(255,255,255,0.18)] shadow-[inset_0_1px_0_rgba(255,255,255,0.22),inset_0_0_0_1px_rgba(255,255,255,0.08),0_1px_3px_rgba(0,0,0,0.25)]"
                : "bg-app-bg-1 shadow-[var(--app-shadow-elevated)]",
            )}
            style={{
              width: `calc((100% - 2 * ${TRACK_INSET}) / ${items.length})`,
              transform: `translateX(${activeIndex * 100}%)`,
            }}
          />
        ) : null}
        {items.map((item) => (
          <TabsPrimitive.Trigger
            key={item.value}
            value={item.value}
            disabled={disabled || item.disabled}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-full px-3",
              "text-xs font-medium whitespace-nowrap",
              "transition-[background-color,box-shadow,color,scale] duration-150",
              "app-press",
              // The thumb paints the active state, so the cell stays transparent above it.
              fill && "relative z-10 min-w-0 justify-center",
              glass
                ? cn(
                    "app-focus [--app-accent-ring:rgba(255,255,255,0.5)]",
                    /* off */
                    "text-app-fg-a3 hover:text-app-fg-4",
                    /* on */
                    "data-[state=active]:text-app-fg-4",
                    !fill &&
                      "data-[state=active]:bg-[rgba(255,255,255,0.18)] data-[state=active]:shadow-[inset_0_1px_0_rgba(255,255,255,0.22),inset_0_0_0_1px_rgba(255,255,255,0.08),0_1px_3px_rgba(0,0,0,0.25)]",
                    "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-app-fg-a3",
                  )
                : cn(
                    "app-focus",
                    /* off */
                    "text-app-fg-3 hover:text-app-fg-4",
                    /* on */
                    "data-[state=active]:text-app-fg-4",
                    !fill &&
                      "data-[state=active]:bg-app-bg-1 data-[state=active]:shadow-[var(--app-shadow-elevated)]",
                    /* disabled */
                    "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-app-fg-3",
                  ),
            )}
          >
            {item.icon ? <span className="inline-flex shrink-0">{item.icon}</span> : null}
            {item.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {/* Radix points each trigger's `aria-controls` at a panel. Empty hidden panels
       * make that id resolve, or the a11y audit fails. */}
      {items.map((item) => (
        <TabsPrimitive.Content key={item.value} value={item.value} forceMount className="hidden" />
      ))}
    </TabsPrimitive.Root>
  );
}
