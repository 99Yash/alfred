/**
 * Dimension-grammar Tabs primitive.
 *
 * Three visual variants — every one is the same control surface, just a
 * different chrome. Pick the variant based on context:
 *
 *   - `underline`  — text-only row sitting on a `border-b border-white/10`
 *                    baseline. Active tab gets a lavender gradient on its
 *                    label + a 2px purple underline that overlaps the
 *                    baseline. Used inside the skill editor (Learn / History).
 *   - `segmented`  — a dark pill track (`rounded-2xl bg-black/20 p-1`) with
 *                    individual tab cells (`rounded-[14px]`). Active cell
 *                    fills with `bg-white/[0.12]`. Used by the rail mode group.
 *   - `pill`       — flat row, no track. Each pill has its own padding +
 *                    rounded-full chrome. Active fills white-ish. Used in
 *                    Settings mode pills (Gmail / Slack / iMessage / …).
 *
 * Item-based API — the consumer passes labels (+ optional icons) and renders
 * the corresponding content panel itself. Tabs is just the chrome.
 *
 * Recipe pulled from dimension-design-reference-2026-05-18.md §2.7.
 */

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
  if (variant === "segmented")
    return <SegmentedTabs {...{ value, onValueChange, items, label, className }} />;
  if (variant === "pill")
    return <PillTabs {...{ value, onValueChange, items, label, className }} />;
  return <UnderlineTabs {...{ value, onValueChange, items, label, className }} />;
}

/* -------------------------------------------------------------------------- */
/* underline                                                                   */
/* -------------------------------------------------------------------------- */

function UnderlineTabs<T extends string>({
  value,
  onValueChange,
  items,
  label,
  className,
}: Omit<TabsProps<T>, "variant">) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn("inline-flex items-center border-b border-white/10", className)}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            role="tab"
            type="button"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onValueChange(item.value)}
            className={cn(
              "relative inline-flex items-center gap-1.5 px-2 pb-1.5 pt-1 text-sm font-medium",
              "transition-[color,transform] duration-200 ease-[cubic-bezier(0.2,0,0,1)]",
              "outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-0",
              "active:scale-[0.98]",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              active ? "heading-display-lavender" : "text-gray-800 hover:text-gray-900",
            )}
          >
            {item.icon ? <span className="inline-flex shrink-0">{item.icon}</span> : null}
            {item.label}
            {active ? (
              <span
                aria-hidden
                className="absolute inset-x-0 -bottom-px h-px bg-[rgb(var(--purple-400))]"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* segmented                                                                   */
/* -------------------------------------------------------------------------- */

function SegmentedTabs<T extends string>({
  value,
  onValueChange,
  items,
  label,
  className,
}: Omit<TabsProps<T>, "variant">) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-1 rounded-2xl bg-black/20 p-1 backdrop-blur-sm",
        className,
      )}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            role="tab"
            type="button"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onValueChange(item.value)}
            className={cn(
              "h-9 min-w-14 rounded-[14px] px-3 grid place-items-center gap-1.5 text-sm font-medium",
              "transition-[background-color,color,box-shadow,transform] duration-200 ease-[cubic-bezier(0.2,0,0,1)]",
              "outline-none focus-visible:ring-2 focus-visible:ring-purple-500",
              "active:scale-[0.96]",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              active
                ? "bg-white/[0.12] text-gray-1000 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.14)]"
                : "text-gray-800 hover:text-gray-900",
            )}
          >
            {item.icon ? <span className="inline-flex shrink-0">{item.icon}</span> : null}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* pill                                                                        */
/* -------------------------------------------------------------------------- */

function PillTabs<T extends string>({
  value,
  onValueChange,
  items,
  label,
  className,
}: Omit<TabsProps<T>, "variant">) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn("inline-flex items-center gap-1.5", className)}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            role="tab"
            type="button"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onValueChange(item.value)}
            className={cn(
              "inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-sm font-medium",
              "transition-[background-color,color,transform] duration-200 ease-[cubic-bezier(0.2,0,0,1)]",
              "outline-none focus-visible:ring-2 focus-visible:ring-purple-500",
              "active:scale-[0.97]",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              active ? "bg-white/90 text-gray-50" : "text-gray-800 hover:text-gray-900",
            )}
          >
            {item.icon ? <span className="inline-flex shrink-0">{item.icon}</span> : null}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
