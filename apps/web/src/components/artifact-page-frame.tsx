import { useCallback, useState } from "react";
import { cn } from "~/lib/utils";

const PAGE_WIDTH = 816;
const PAGE_HEIGHT = 1056;

export function ArtifactPageFrame({
  html,
  title,
  className,
}: {
  html: string;
  title: string;
  className?: string;
}) {
  // `width` is undefined until the frame has been measured. The iframe falls
  // back to scale 1 in that single pre-measurement frame; ResizeObserver fires
  // synchronously on attach, so the unscaled frame is rarely visible.
  const [width, setWidth] = useState<number | undefined>(undefined);

  // Callback ref with a cleanup return (React 19) replaces a useState-in-effect
  // pattern — the observer attaches when the node mounts and disconnects when
  // it unmounts, without a separate useEffect to read DOM state at init time.
  const frameRef = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const nextWidth = element.getBoundingClientRect().width;
      if (nextWidth > 0) setWidth(nextWidth);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scale = width !== undefined ? width / PAGE_WIDTH : 1;

  return (
    <div
      ref={frameRef}
      className={cn(
        "relative aspect-[8.5/11] overflow-hidden rounded-lg bg-white shadow-2xl",
        className,
      )}
    >
      <iframe
        title={title}
        srcDoc={html}
        sandbox=""
        className="pointer-events-none absolute left-0 top-0 border-0 bg-white"
        style={{
          width: PAGE_WIDTH,
          height: PAGE_HEIGHT,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      />
    </div>
  );
}
