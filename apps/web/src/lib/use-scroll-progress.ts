import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Tracks the scroll progress (0..1) of a scrollable element. The returned
 * value updates on every animation frame while the element is scrolling and
 * is throttled to once per frame so it never blocks the main thread.
 *
 * Pass the scroll container's ref; reads scrollTop / scrollHeight - clientHeight.
 * Returns 0 until the ref is mounted, 1 when at the bottom.
 */
export function useScrollProgress(scrollRef: RefObject<HTMLElement | null>): number {
  const [progress, setProgress] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const tick = () => {
      rafRef.current = null;
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 0) {
        setProgress(0);
        return;
      }
      const next = Math.min(1, Math.max(0, el.scrollTop / max));
      setProgress(next);
    };

    const onScroll = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(tick);
    };

    // Prime with the current position so first paint matches scroll state.
    tick();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [scrollRef]);

  return progress;
}
