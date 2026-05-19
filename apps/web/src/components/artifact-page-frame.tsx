import { useEffect, useRef, useState } from "react";
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
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(PAGE_WIDTH);

  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;

    const updateWidth = () => {
      const nextWidth = element.getBoundingClientRect().width;
      if (nextWidth > 0) setWidth(nextWidth);
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scale = width / PAGE_WIDTH;

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
