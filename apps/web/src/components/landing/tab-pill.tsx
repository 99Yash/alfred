import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { tabButtonId, tabPanelId, type TabPillOption } from "~/components/landing/tab-pill-ids";
import { cn } from "~/lib/utils";

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
  /**
   * Shared id prefix for tab buttons and their panels. Pass the same
   * value used by `tabPanelId` on the rendered panels. Defaults to a
   * `useId`-generated string when omitted.
   */
  idBase?: string | undefined;
  /**
   * `glass` — self-contained frosted pill with its own border and aurora
   * halo. Use when the row floats over a busy surface and has to hold its
   * own shape.
   *
   * `bare` — no outer chrome at all. Use when the row already sits inside a
   * container that supplies the shape, e.g. the hero band's notch, where a
   * bordered pill inside a notch would read as two nested containers. Never
   * stack a light translucent surface on another translucent surface —
   * legibility collapses and the shapes fight.
   */
  variant?: TabPillVariant | undefined;
  className?: string | undefined;
}) {
  const generatedId = useId();
  const idBase = idBaseProp ?? generatedId;
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Sliding-indicator geometry. Null until the first layout pass so the
  // indicator doesn't flash at x=0 on mount.
  const [indicator, setIndicator] = useState<{
    x: number;
    width: number;
  } | null>(null);

  // Measure the active button relative to the tablist and park the
  // indicator on it. useLayoutEffect runs before paint, so the indicator
  // is positioned correctly on the very first frame.
  useLayoutEffect(() => {
    const list = listRef.current;
    const index = options.findIndex((o) => o.value === value);
    const button = buttonRefs.current[index];
    if (!list || !button) return;
    const listRect = list.getBoundingClientRect();
    const btnRect = button.getBoundingClientRect();
    setIndicator({ x: btnRect.left - listRect.left, width: btnRect.width });
  }, [value, options]);

  // Recompute on container resize so font-load shifts, viewport changes,
  // or option label edits don't leave the indicator misaligned.
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
      ref={listRef}
      role="tablist"
      aria-orientation="horizontal"
      // `tabIndex={-1}` satisfies the rule that interactive roles with
      // handlers be focusable, without putting the container itself in
      // the tab order — the active child tab remains the keyboard entry
      // point per the WAI-ARIA tabs pattern.
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={cn(
        "relative inline-flex items-center rounded-full p-1",
        variant === "glass" &&
          cn(
            // Tinted glass — dark enough to give the pill body against the
            // aurora, glassy enough to still feel lit by it.
            "border border-white/[0.12] bg-black/40 backdrop-blur-xl",
            "shadow-[inset_0_1px_0_rgba(255,255,255,0.08),inset_0_-1px_0_rgba(0,0,0,0.4),0_12px_36px_-12px_rgba(99,102,241,0.45)]",
          ),
        className,
      )}
    >
      {/* Sliding active indicator. The glass variant picks up the indigo aurora
       * behind the pill so it reads as lit rather than painted; the bare
       * variant only needs to mark position, so it stays a quiet neutral fill
       * and lets the label carry the state.
       *
       * `cubic-bezier(0.32,0.72,0,1)` is a critically-damped curve: it leaves
       * fast, arrives without overshoot, and settles. Overshoot would be wrong
       * here — no gesture carried momentum into this move, the tab simply
       * changed. */}
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
