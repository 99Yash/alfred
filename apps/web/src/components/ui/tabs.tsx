/**
 * Tabs chrome on Radix tabs: `underline`, `segmented`, or `pill`.
 * The caller renders the panels.
 */

import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export type TabsVariant = "underline" | "segmented" | "pill";

interface TabItem<T extends string = string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode | undefined;
  disabled?: boolean | undefined;
}

interface TabsProps<T extends string = string> {
  variant?: TabsVariant | undefined;
  value: T;
  onValueChange: (value: T) => void;
  items: ReadonlyArray<TabItem<T>>;
  /** Defaults to "Tabs". */
  label?: string | undefined;
  className?: string | undefined;
}

export function Tabs<T extends string = string>({
  variant = "underline",
  value,
  onValueChange,
  items,
  label = "Tabs",
  className,
}: TabsProps<T>) {
  // SAFETY: Radix emits the value of a rendered item, which is a T.
  const emit = (next: string) => onValueChange(next as T);

  return (
    <TabsPrimitive.Root value={value} onValueChange={emit}>
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
