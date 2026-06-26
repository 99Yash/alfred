import type { ArtifactFormat } from "@alfred/contracts";
import { useCallback, useState } from "react";
import { cn } from "~/lib/utils";

// Page geometry per artifact format. `pdf` is portrait US-Letter (816×1056 =
// 8.5×11 at 96dpi); `slides` is a 1280×720 16:9 deck page. The iframe renders
// at this fixed logical size and is scaled to the measured container width, so
// page HTML can be authored against a stable canvas regardless of panel width.
const PAGE_GEOMETRY: Record<ArtifactFormat, { width: number; height: number; aspect: string }> = {
  pdf: { width: 816, height: 1056, aspect: "aspect-[8.5/11]" },
  slides: { width: 1280, height: 720, aspect: "aspect-video" },
};

export function ArtifactPageFrame({
  html,
  title,
  className,
  format = "pdf",
}: {
  html: string;
  title: string;
  className?: string;
  /** Drives page geometry/aspect. Defaults to `pdf` (portrait US-Letter). */
  format?: ArtifactFormat;
}) {
  const { width: pageWidth, height: pageHeight, aspect } = PAGE_GEOMETRY[format];
  // `width` is undefined until the frame has been measured. The iframe falls
  // back to scale 1 in that single pre-measurement frame; ResizeObserver fires
  // synchronously on attach, so the unscaled frame is rarely visible.
  const [width, setWidth] = useState<number | undefined>(undefined);

  // Callback ref with a cleanup return (React 19) replaces a useState-in-effect
  // pattern — the observer attaches when the node mounts and disconnects when
  // it unmounts, without a separate useEffect to read DOM state at init time.
  const frameRef = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    // Read the layout content-box from the ResizeObserver entry rather than
    // `getBoundingClientRect()`, which folds in ancestor CSS transforms — an
    // animating `scale(...)` ancestor (e.g. the fullscreen present entrance)
    // would otherwise be measured mid-animation and leave the iframe scaled to
    // the shrunken width once the transform settles.
    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width ?? 0;
      if (nextWidth > 0) setWidth(nextWidth);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scale = width !== undefined ? width / pageWidth : 1;

  return (
    <div
      ref={frameRef}
      className={cn("relative overflow-hidden rounded-lg bg-white shadow-2xl", aspect, className)}
    >
      <iframe
        title={title}
        srcDoc={html}
        sandbox=""
        className="pointer-events-none absolute left-0 top-0 border-0 bg-white"
        style={{
          width: pageWidth,
          height: pageHeight,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      />
    </div>
  );
}
