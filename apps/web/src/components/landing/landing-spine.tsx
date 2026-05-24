import { useEffect, useState } from "react";
import { cn } from "~/lib/utils";

/**
 * Vertical "timeline" line that runs the full height of the landing. Two
 * layers:
 *   • base: a thin neutral-900 rail (`bg-neutral-900 w-[2px] inset-y-0`)
 *   • progress overlay: a brighter neutral-600 segment from the top, height
 *     tied to window scroll position so it grows as the reader descends.
 *
 * On mobile the spine sits 20px from the viewport edge so it has air; at
 * `sm` it pushes to 40px; at `lg` it snaps to the LEFT EDGE of the
 * `max-w-5xl` content column. Section spine markers translate-x onto this
 * same vertical line so they read as nodes on a timeline.
 *
 * Borrowed from firstquadrant.ai's landing pattern — the spine is the visual
 * signature that makes the page feel like one continuous narrative.
 */
export function LandingSpine() {
  const progress = useWindowScrollProgress();

  return (
    <>
      {/* Base rail — full height */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 z-0 w-[2px]",
          "bg-neutral-900",
          "left-5 sm:left-10 lg:left-0",
        )}
      />
      {/* Progress overlay — grows top-down with scroll */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-0 z-0 w-[2px]",
          "bg-neutral-600",
          "left-5 sm:left-10 lg:left-0",
        )}
        style={{
          height: `${Math.max(0, Math.min(100, progress * 100)).toFixed(2)}%`,
        }}
      />
    </>
  );
}

/**
 * Tracks the scroll progress of the window (0..1). Mirrors the existing
 * `useScrollProgress` but reads from `window.scrollY` instead of a ref'd
 * container — which is the right primitive for a page that scrolls the
 * document body, as the new landing does.
 */
function useWindowScrollProgress(): number {
  const [progress, setProgress] = useState(() => computeScrollProgress());

  useEffect(() => {
    let rafId: number | null = null;
    const tick = () => {
      rafId = null;
      setProgress(computeScrollProgress());
    };
    const onScroll = () => {
      if (rafId != null) return;
      rafId = requestAnimationFrame(tick);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, []);

  return progress;
}

function computeScrollProgress(): number {
  if (typeof window === "undefined") return 0;
  const max = (document.documentElement.scrollHeight || 0) - window.innerHeight;
  if (max <= 0) return 0;
  return Math.min(1, Math.max(0, window.scrollY / max));
}
