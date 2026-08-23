import { useEffect, useState, type ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * The landing's primary navigation — a translucent pill, pinned top-center,
 * with the page scrolling underneath it.
 *
 * Two deliberate choices:
 *
 * **Top, not bottom.** This nav used to sit at `bottom-8`, which put the
 * page's wayfinding in the one place nobody looks for it and parked it on top
 * of the hero product panel. Things that look the same must behave the same
 * and live in the same place; site navigation lives at the top.
 *
 * **It materializes on scroll.** At the very top of the page there is nothing
 * behind the nav to separate it from, so it carries no material at all — just
 * the logo and links floating on the canvas. Once content starts passing
 * underneath, the glass fades in to keep the labels legible over whatever is
 * behind them. That is a scroll edge effect rather than a permanent bar with a
 * hard divider: the chrome appears only where it actually overlaps content.
 */
export function FloatingPillNav({
  logo,
  children,
  cta,
  className,
}: {
  logo?: ReactNode | undefined;
  children?: ReactNode | undefined;
  cta?: ReactNode | undefined;
  className?: string | undefined;
}) {
  const scrolled = useHasScrolledPast(24);

  return (
    <nav
      aria-label="Primary"
      data-scrolled={scrolled || undefined}
      className={cn(
        "fixed inset-x-0 top-3 z-50 mx-auto h-fit sm:top-5",
        "w-fit max-w-[calc(100vw-1.5rem)]",
        "flex items-center gap-1 rounded-full p-1.5 sm:gap-2 sm:p-2",
        // The material lives on a pseudo-element so its opacity transition
        // never fights a transition on the nav's own contents.
        "before:absolute before:inset-0 before:-z-10 before:rounded-full",
        "before:bg-black/55 before:backdrop-blur-xl",
        "before:ring-1 before:ring-white/10 before:ring-inset",
        // A bright top hairline is light catching the near lip of the glass.
        "before:shadow-[inset_0_1px_0_rgba(255,255,255,0.10),0_18px_50px_-24px_rgba(0,0,0,0.9)]",
        "before:opacity-0 before:transition-opacity before:duration-300",
        "data-[scrolled]:before:opacity-100",
        className,
      )}
    >
      {logo ? <div className="flex items-center gap-2 pr-1 pl-2">{logo}</div> : null}
      {children ? (
        <>
          <div aria-hidden className="hidden h-5 w-px shrink-0 bg-white/10 sm:block" />
          <div className="hidden items-center gap-0.5 text-sm text-white sm:flex">{children}</div>
        </>
      ) : null}
      {cta ? <div className="shrink-0 pl-1">{cta}</div> : null}
    </nav>
  );
}

/**
 * True once the document has scrolled more than `threshold` px. Reads on a
 * rAF-throttled passive scroll listener — the display-synced clock is the
 * right cadence for anything driven by scroll position, and one boolean of
 * state means the nav re-renders twice per page, not once per frame.
 */
function useHasScrolledPast(threshold: number): boolean {
  const [past, setPast] = useState(
    () => typeof window !== "undefined" && window.scrollY > threshold,
  );

  useEffect(() => {
    let rafId: number | null = null;
    const read = () => {
      rafId = null;
      setPast(window.scrollY > threshold);
    };
    const onScroll = () => {
      if (rafId != null) return;
      rafId = requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [threshold]);

  return past;
}
