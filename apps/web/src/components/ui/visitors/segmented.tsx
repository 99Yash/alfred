/**
 * Visitors-now-grammar segmented control.
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

export interface VsSegmentedItem<T extends string = string> {
  value: T;
  label: ReactNode;
  /** Optional leading icon. */
  icon?: ReactNode;
  disabled?: boolean;
}

interface VsSegmentedProps<T extends string = string> {
  value: T;
  onValueChange: (value: T) => void;
  items: ReadonlyArray<VsSegmentedItem<T>>;
  /** ARIA label for the tablist. */
  label?: string;
  className?: string;
}

export function VsSegmented<T extends string = string>({
  value,
  onValueChange,
  items,
  label = "Options",
  className,
}: VsSegmentedProps<T>) {
  return (
    <TabsPrimitive.Root value={value} onValueChange={(next) => onValueChange(next as T)}>
      <TabsPrimitive.List
        aria-label={label}
        className={cn(
          "inline-flex items-center gap-1 p-1 rounded-xl",
          "bg-vs-bg-2 ring-1 ring-vs-bg-3",
          className,
        )}
      >
        {items.map((item) => (
          <TabsPrimitive.Trigger
            key={item.value}
            value={item.value}
            disabled={item.disabled}
            className={cn(
              "inline-flex items-center gap-1.5 h-7 px-3 rounded-lg",
              "text-xs font-medium whitespace-nowrap",
              "transition-all duration-150",
              "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-bg-2",
              "vs-press",
              /* off state */
              "text-vs-fg-3 hover:text-vs-fg-4",
              /* on state */
              "data-[state=active]:bg-vs-bg-1 data-[state=active]:text-vs-fg-4",
              "data-[state=active]:shadow-[var(--vs-shadow-elevated)]",
              /* disabled */
              "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-vs-fg-3",
            )}
          >
            {item.icon ? <span className="inline-flex shrink-0">{item.icon}</span> : null}
            {item.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}
