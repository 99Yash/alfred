import { useEffect, useRef, useState, type ReactNode } from "react";
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
 * A numbered node anchored to the spine. Place at the start of each section;
 * the negative translate-x pulls the circle onto the spine line. The `label`
 * sits next to it as the section eyebrow.
 *
 * Children render to the right of the marker (the section eyebrow text).
 */
export function SpineMarker({
  index,
  children,
}: {
  index: number;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative z-10 flex items-center gap-5",
        // Pull leftward so the circle's CENTER sits ON the spine line. The
        // circle is size-7 (28px), so translating its left edge by -14px puts
        // the center 14px to the left of the section content's leading edge —
        // which is where the spine lives at every breakpoint (spine `left-5`
        // matches wrapper `px-5`, `left-10` matches `px-10`, `left-0` matches
        // `lg:px-0`).
        "-translate-x-[14px]",
      )}
    >
      <span
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-full",
          "bg-neutral-700 text-[12.5px] font-medium tabular text-white",
          "ring-4 ring-[#0a0a0a]",
        )}
        aria-hidden
      >
        {String(index).padStart(2, "0")}
      </span>
      {children ? (
        <span className="text-[12.5px] font-medium uppercase tracking-[0.18em] text-neutral-400">
          {children}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Tracks the scroll progress of the window (0..1). Mirrors the existing
 * `useScrollProgress` but reads from `window.scrollY` instead of a ref'd
 * container — which is the right primitive for a page that scrolls the
 * document body, as the new landing does.
 */
function useWindowScrollProgress(): number {
  const [progress, setProgress] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const tick = () => {
      rafRef.current = null;
      const max =
        (document.documentElement.scrollHeight || 0) - window.innerHeight;
      if (max <= 0) {
        setProgress(0);
        return;
      }
      const next = Math.min(1, Math.max(0, window.scrollY / max));
      setProgress(next);
    };

    const onScroll = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(tick);
    };

    tick();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return progress;
}
