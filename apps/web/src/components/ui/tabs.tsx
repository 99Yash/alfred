/**
 * Dimension-grammar Tabs primitive.
 *
 * Three visual variants — every one is the same control surface, just a
 * different chrome. Pick the variant based on context:
 *
 *   - `underline`  — text-only row sitting on a `border-b border-white/10`
 *                    baseline. Active tab gets a lavender gradient on its
 *                    label + a 1px purple underline that overlaps the
 *                    baseline. Used inside the skill editor (Learn / History).
 *   - `segmented`  — a dark pill track (`rounded-2xl bg-black/20 p-1`) with
 *                    individual tab cells (`rounded-[14px]`). Active cell
 *                    fills with `bg-white/[0.12]`. Used by the rail mode group.
 *   - `pill`       — flat row, no track. Each pill has its own padding +
 *                    rounded-full chrome. Active fills white-ish with dark
 *                    text. Used in Settings mode pills (Gmail / Slack / …).
 *
 * Item-based API — the consumer passes labels (+ optional icons) and renders
 * the corresponding content panel itself. Tabs is just the chrome. Built on
 * `@radix-ui/react-tabs` so we get roving tabindex, arrow-key navigation,
 * Home/End cycling, and proper `disabled` semantics for free.
 */

import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export type TabsVariant = "underline" | "segmented" | "pill";

export interface TabItem<T extends string = string> {
  value: T;
  label: ReactNode;
  /** Optional leading icon — typically a 14px Lucide glyph. */
  icon?: ReactNode;
  disabled?: boolean;
}

interface TabsProps<T extends string = string> {
  variant?: TabsVariant;
  value: T;
  onValueChange: (value: T) => void;
  items: ReadonlyArray<TabItem<T>>;
  /** ARIA label for the tablist. Defaults to "Tabs". */
  label?: string;
  className?: string;
}

export function Tabs<T extends string = string>({
  variant = "underline",
  value,
  onValueChange,
  items,
  label = "Tabs",
  className,
}: TabsProps<T>) {
  return (
    <TabsPrimitive.Root value={value} onValueChange={(next) => onValueChange(next as T)}>
      <TabsPrimitive.List aria-label={label} className={listClassName(variant, className)}>
        {items.map((item) => (
          <TabsPrimitive.Trigger
            key={item.value}
            value={item.value}
            disabled={item.disabled}
            className={triggerClassName(variant)}
          >
            {item.icon ? <span className="inline-flex shrink-0">{item.icon}</span> : null}
            {item.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}

/* -------------------------------------------------------------------------- */
/* variant chrome                                                              */
/* -------------------------------------------------------------------------- */

function listClassName(variant: TabsVariant, className?: string): string {
  if (variant === "segmented") {
    return cn(
      "inline-flex items-center gap-1 rounded-2xl bg-black/20 p-1 backdrop-blur-sm",
      className,
    );
  }
  if (variant === "pill") {
    return cn("inline-flex items-center gap-1.5", className);
  }
  return cn("inline-flex items-center border-b border-white/10", className);
}

function triggerClassName(variant: TabsVariant): string {
  const base = cn(
    "outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-0",
    "disabled:cursor-not-allowed disabled:opacity-50",
    "transition-[background-color,color,box-shadow,transform] duration-200 ease-[cubic-bezier(0.2,0,0,1)]",
  );

  if (variant === "segmented") {
    return cn(
      base,
      "grid h-9 min-w-14 place-items-center gap-1.5 rounded-[14px] px-3 text-sm font-medium",
      "active:scale-[0.96]",
      "text-gray-800 hover:text-gray-900",
      "data-[state=active]:bg-white/[0.12] data-[state=active]:text-gray-1000",
      "data-[state=active]:shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.14)]",
    );
  }

  if (variant === "pill") {
    return cn(
      base,
      "inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-medium",
      "active:scale-[0.97]",
      "text-gray-800 hover:text-gray-900",
      "data-[state=active]:bg-white/90 data-[state=active]:text-gray-50",
    );
  }

  return cn(
    base,
    "relative inline-flex items-center gap-1.5 px-2 pt-1 pb-1.5 text-sm font-medium",
    "active:scale-[0.98]",
    "text-gray-800 hover:text-gray-900",
    "data-[state=active]:heading-display-lavender",
    "after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-[rgb(var(--purple-400))]",
    "after:opacity-0 data-[state=active]:after:opacity-100",
  );
}
