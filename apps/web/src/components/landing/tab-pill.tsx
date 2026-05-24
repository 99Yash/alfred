import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "~/lib/utils";

export interface TabPillOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

/** Stable id for a tab button — pair with `tabPanelId` for `aria-controls`. */
export function tabButtonId(idBase: string, value: string): string {
  return `${idBase}-tab-${value}`;
}

/** Stable id for a tab panel — set on the panel and referenced by `aria-controls`. */
export function tabPanelId(idBase: string, value: string): string {
  return `${idBase}-panel-${value}`;
}

/**
 * Segmented control rendered as a dark rounded pill. Modeled on
 * visitors.now's `Dashboard · Profiles · Funnels …` row above their hero
 * mockup. Active tab gets a lighter neutral fill + white text; inactive
 * tabs read as muted neutral.
 *
 * Generic over the value type so callers can pass a string union and get
 * type-checked `onChange` calls.
 *
 * Implements the WAI-ARIA tabs pattern: roving tabIndex (active tab is
 * focusable, others are skipped), Left/Right cycle through tabs, Home/End
 * jump to the ends, and `aria-controls` ties each button to the matching
 * panel id via `tabPanelId(idBase, value)`. Callers render the panels
 * themselves and must use `tabPanelId` so the relationship is consistent.
 */
export function TabPill<T extends string>({
  options,
  value,
  onChange,
  idBase: idBaseProp,
  className,
}: {
  options: ReadonlyArray<TabPillOption<T>>;
  value: T;
  onChange: (next: T) => void;
  /**
   * Shared id prefix for tab buttons and their panels. Pass the same
   * value used by `tabPanelId` on the rendered panels. Defaults to a
   * `useId`-generated string when omitted.
   */
  idBase?: string;
  className?: string;
}) {
  const generatedId = useId();
  const idBase = idBaseProp ?? generatedId;
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const focusTabAt = (index: number) => {
    const target = options[index];
    if (!target) return;
    onChange(target.value);
    // The roving tabIndex updates on the next render — focus the button
    // synchronously so keyboard users see the focus follow the arrow press.
    buttonRefs.current[index]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = options.findIndex((o) => o.value === value);
    if (currentIndex === -1) return;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown": {
        event.preventDefault();
        focusTabAt((currentIndex + 1) % options.length);
        break;
      }
      case "ArrowLeft":
      case "ArrowUp": {
        event.preventDefault();
        focusTabAt((currentIndex - 1 + options.length) % options.length);
        break;
      }
      case "Home": {
        event.preventDefault();
        focusTabAt(0);
        break;
      }
      case "End": {
        event.preventDefault();
        focusTabAt(options.length - 1);
        break;
      }
    }
  };

  return (
    <div
      role="tablist"
      aria-orientation="horizontal"
      // `tabIndex={-1}` satisfies the rule that interactive roles with
      // handlers be focusable, without putting the container itself in
      // the tab order — the active child tab remains the keyboard entry
      // point per the WAI-ARIA tabs pattern.
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={cn(
        "inline-flex items-center gap-1 rounded-full",
        "border border-neutral-800/80 bg-neutral-900/70 p-1 backdrop-blur-md",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
        className,
      )}
    >
      {options.map((opt, index) => {
        const isActive = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              buttonRefs.current[index] = el;
            }}
            id={tabButtonId(idBase, opt.value)}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={tabPanelId(idBase, opt.value)}
            tabIndex={isActive ? 0 : -1}
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
