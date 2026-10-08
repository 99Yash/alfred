import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { tabButtonId, tabPanelId, type TabPillOption } from "~/components/landing/tab-pill-ids";
import { cn } from "~/lib/utils";

/**
 * Segmented tab control as a dark pill, using the WAI-ARIA tabs pattern.
 * Callers render the panels and must give them ids from `tabPanelId`.
 */
export type TabPillVariant = "glass" | "bare";

export function TabPill<T extends string>({
  options,
  value,
  onChange,
  idBase: idBaseProp,
  variant = "glass",
  className,
}: {
  options: ReadonlyArray<TabPillOption<T>>;
  value: T;
  onChange: (next: T) => void;
  /** Id prefix for tabs and panels; pass the same value to `tabPanelId`. Defaults to `useId`. */
  idBase?: string | undefined;
  /**
   * `glass`: frosted pill with its own border, for busy backgrounds.
   * `bare`: no chrome, for a container that already gives the shape (the hero notch).
   */
  variant?: TabPillVariant | undefined;
  className?: string | undefined;
}) {
  const generatedId = useId();
  const idBase = idBaseProp ?? generatedId;
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Null until the first layout, so the indicator does not flash at x=0.
  const [indicator, setIndicator] = useState<{
    x: number;
    width: number;
  } | null>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    const index = options.findIndex((o) => o.value === value);
    const button = buttonRefs.current[index];

    if (!list || !button) return;
    const listRect = list.getBoundingClientRect();
    const btnRect = button.getBoundingClientRect();
    setIndicator({ x: btnRect.left - listRect.left, width: btnRect.width });
  }, [value, options]);

  // Re-measure on resize: font loads and label changes shift the buttons.
  useEffect(() => {
    const list = listRef.current;

    if (!list || typeof ResizeObserver === "undefined") return;

    const ro = new ResizeObserver(() => {
      const index = options.findIndex((o) => o.value === value);
      const button = buttonRefs.current[index];

      if (!button) return;
      const listRect = list.getBoundingClientRect();
      const btnRect = button.getBoundingClientRect();
      setIndicator({ x: btnRect.left - listRect.left, width: btnRect.width });
    });

    ro.observe(list);

    return () => ro.disconnect();
  }, [options, value]);

  const focusTabAt = (index: number) => {
    const target = options[index];

    if (!target) return;
    onChange(target.value);
    // tabIndex updates next render; focus now so focus follows the arrow key.
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
      ref={listRef}
      role="tablist"
      aria-orientation="horizontal"
      // Satisfies the focusable-handler lint rule without adding the container to the tab order.
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={cn(
        "relative inline-flex items-center rounded-full p-1",
        variant === "glass" &&
          cn(
            "border border-white/[0.12] bg-black/40 backdrop-blur-xl",
            "shadow-[inset_0_1px_0_rgba(255,255,255,0.08),inset_0_-1px_0_rgba(0,0,0,0.4),0_12px_36px_-12px_rgba(99,102,241,0.45)]",
          ),
        className,
      )}
    >
      {/* Sliding indicator. The curve has no overshoot: no gesture gave this move momentum. */}
      {indicator ? (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-y-1 left-0 rounded-full",
            variant === "glass"
              ? cn(
                  "bg-linear-to-br from-indigo-500/80 via-violet-500/70 to-fuchsia-500/55",
                  "ring-1 ring-white/30 ring-inset",
                  "shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_0_28px_-4px_rgba(139,92,246,0.7)]",
                )
              : cn(
                  "bg-white/[0.08] ring-1 ring-white/10 ring-inset",
                  "shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
                ),
            "transition-[transform,width] duration-[420ms] ease-[cubic-bezier(0.32,0.72,0,1)]",
            "motion-reduce:transition-none",
          )}
          style={{
            width: `${indicator.width}px`,
            transform: `translateX(${indicator.x}px)`,
          }}
        />
      ) : null}
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
              "relative z-10 inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 sm:px-3.5",
              "text-[13px] leading-none font-medium whitespace-nowrap transition-colors duration-200",
              "focus-visible:ring-2 focus-visible:ring-violet-300/60 focus-visible:outline-none",
              isActive ? "text-white" : "text-neutral-400 hover:text-neutral-100",
            )}
          >
            {opt.icon ? (
              <span
                aria-hidden
                className={cn(
                  "flex shrink-0 items-center transition-colors duration-200",
                  isActive ? "text-white" : "text-neutral-500",
                )}
              >
                {opt.icon}
              </span>
            ) : null}
            <span>{opt.label}</span>
            {opt.badge ? (
              <span
                className={cn(
                  "rounded-full px-1.5 py-px text-[9.5px] font-semibold tracking-[0.08em] uppercase",
                  "bg-amber-400/12 text-amber-300/90 ring-1 ring-amber-400/20 ring-inset",
                )}
              >
                {opt.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
