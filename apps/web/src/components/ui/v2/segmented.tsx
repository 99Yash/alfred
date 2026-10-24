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
          "inline-flex items-center gap-1 rounded-full p-1",
          glass
            ? // The rail's `.app-media` scope gives these tokens their dark values over the video.
              "bg-app-bg-a4 shadow-[0_1px_12px_rgba(0,0,0,0.18)] ring-1 ring-app-bg-a4 backdrop-blur-xl backdrop-saturate-150"
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
              "inline-flex h-7 items-center gap-1.5 rounded-full px-3",
              "text-xs font-medium whitespace-nowrap",
              "transition-[background-color,box-shadow,color,scale] duration-150",
              "app-press",
              glass
                ? cn(
                    "app-focus [--app-accent-ring:rgba(255,255,255,0.5)]",
                    /* off */
                    "text-app-fg-a3 hover:text-app-fg-4",
                    /* on: a dark chip in the navy of the rail's bottom scrim */
                    "data-[state=active]:bg-[rgba(7,17,31,0.72)] data-[state=active]:text-app-fg-4",
                    "data-[state=active]:ring-1 data-[state=active]:ring-app-bg-a3",
                    "data-[state=active]:shadow-[var(--app-shadow-elevated)]",
                    "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-app-fg-a3",
                  )
                : cn(
                    "app-focus",
                    /* off */
                    "text-app-fg-3 hover:text-app-fg-4",
                    /* on */
                    "data-[state=active]:bg-app-bg-1 data-[state=active]:text-app-fg-4",
                    "data-[state=active]:shadow-[var(--app-shadow-elevated)]",
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
