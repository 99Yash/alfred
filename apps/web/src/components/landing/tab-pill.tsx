import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export interface TabPillOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

/**
 * Segmented control rendered as a dark rounded pill. Modeled on
 * visitors.now's `Dashboard · Profiles · Funnels …` row above their hero
 * mockup. Active tab gets a lighter neutral fill + white text; inactive
 * tabs read as muted neutral.
 *
 * Generic over the value type so callers can pass a string union and get
 * type-checked `onChange` calls.
 */
export function TabPill<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: ReadonlyArray<TabPillOption<T>>;
  value: T;
  onChange: (next: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-orientation="horizontal"
      className={cn(
        "inline-flex items-center gap-1 rounded-full",
        "border border-neutral-800/80 bg-neutral-900/70 p-1 backdrop-blur-md",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
        className,
      )}
    >
      {options.map((opt) => {
        const isActive = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(opt.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5",
              "text-[13px] font-medium leading-none transition-colors duration-200",
              isActive
                ? "bg-neutral-700/60 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                : "text-neutral-400 hover:text-neutral-200",
            )}
          >
            {opt.icon ? (
              <span className="flex shrink-0 items-center" aria-hidden>
                {opt.icon}
              </span>
            ) : null}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
