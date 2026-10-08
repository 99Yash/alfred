import { useEffect, useState, type ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * Landing nav: a pill pinned top-center. It has no glass at the top of the page;
 * the glass fades in once content scrolls under it.
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
        // Glass on a pseudo-element, so its fade does not fight the contents' transitions.
        "before:absolute before:inset-0 before:-z-10 before:rounded-full",
        "before:bg-black/55 before:backdrop-blur-xl",
        "before:ring-1 before:ring-white/10 before:ring-inset",
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

/** True past `threshold` px. rAF-throttled, and re-renders only when the boolean flips. */
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
