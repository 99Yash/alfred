import { useEffect, useRef } from "react";
import { cn } from "~/lib/utils";

/* Hero showcase clips. Stopgaps from dimension's site until Alfred-branded clips exist. */

/**
 * Edges that fade instead of cutting. Some clips are crops that stop mid-content,
 * and a soft edge reads as "continues past the frame". The video box equals the
 * painted area, so the fade lands on the real edge.
 */
export type ShowcaseFadeEdge = "left" | "right" | "bottom";

const EDGE_MASK = {
  left: "linear-gradient(to right, transparent 0%, #000 12%, #000 100%)",
  right: "linear-gradient(to right, #000 0%, #000 88%, transparent 100%)",
  bottom: "linear-gradient(to bottom, #000 0%, #000 86%, transparent 100%)",
} satisfies Record<ShowcaseFadeEdge, string>;

/** Looping clip. Muted, autoPlay, loop, and playsInline satisfy mobile autoplay rules. */
export function ShowcaseVideo({
  src,
  label,
  className,
  objectPosition = "top",
  fadeEdges,
  active = true,
}: {
  src: string;
  label: string;
  className?: string | undefined;
  objectPosition?: "top" | "center" | undefined;
  /** Edges where the clip's own framing cuts content. */
  fadeEdges?: ReadonlyArray<ShowcaseFadeEdge> | undefined;
  /** Restart from frame 0 when the tab becomes active. */
  active?: boolean | undefined;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;

    if (!video || !active) return;
    video.currentTime = 0;
    void video.play().catch(() => {
      // Autoplay can be blocked before interaction; a rejected play() is fine.
    });
  }, [active]);

  // `mask-composite: intersect` lets each edge fade on its own.
  const mask = fadeEdges?.length ? fadeEdges.map((edge) => EDGE_MASK[edge]).join(", ") : undefined;

  return (
    <video
      ref={ref}
      className={cn("size-full object-cover", className)}
      style={{
        objectPosition,
        ...(mask
          ? {
              maskImage: mask,
              WebkitMaskImage: mask,
              maskComposite: "intersect",
              WebkitMaskComposite: "source-in",
            }
          : {}),
      }}
      src={src}
      autoPlay
      loop
      muted
      playsInline
      preload="metadata"
      aria-label={label}
    />
  );
}
