import { useEffect, useRef } from "react";
import { cn } from "~/lib/utils";

/**
 * Media helper for the hero showcase tabs. Each tab's content is a
 * self-contained, full-bleed clip that fills the device bezel — the bezel's
 * fixed aspect (`aspect-[1.29/1]` in HeroShowcase) keeps every tab the same
 * size so the crossfade never jumps.
 *
 * (These clips are brand-stopgaps sourced from dimension's site; the plan is
 * to replace them with Alfred-branded clips rendered in Open Runde.)
 */

/**
 * Which edges of the clip fade out instead of ending on a hard cut.
 *
 * Two of the three source clips are crops of a wider recording, so their own
 * pixels stop mid-content: the inbox clip cuts subject lines mid-word at the
 * right edge, and the briefing clip cuts its last bullet mid-line at the
 * bottom. A hard edge on truncated content reads as a broken crop. The same
 * content behind a soft fade reads as "this continues past the frame", which
 * is both true and the convention every scrolling surface already uses.
 *
 * The mask is applied to the video element, and the element's box is exactly
 * the painted region (the bezel's aspect matches the clip's, and `object-cover`
 * fills it), so the fade always lands on the real content edge.
 */
export type ShowcaseFadeEdge = "left" | "right" | "bottom";

const EDGE_MASK = {
  left: "linear-gradient(to right, transparent 0%, #000 12%, #000 100%)",
  right: "linear-gradient(to right, #000 0%, #000 88%, transparent 100%)",
  bottom: "linear-gradient(to bottom, #000 0%, #000 86%, transparent 100%)",
} satisfies Record<ShowcaseFadeEdge, string>;

/** Full-bleed looping product clip. Muted + autoPlay + loop + playsInline is
 * the standard recipe for a silent ambient hero clip that also satisfies
 * mobile autoplay policies. */
export function ShowcaseVideo({
  src,
  label,
  className,
  objectPosition = "top",
  fadeEdges,
  active = true,
}: {
  src: string;
  /** Accessible description of what the clip shows. */
  label: string;
  className?: string | undefined;
  objectPosition?: "top" | "center" | undefined;
  /** Edges where this clip's own framing truncates content. See ShowcaseFadeEdge. */
  fadeEdges?: ReadonlyArray<ShowcaseFadeEdge> | undefined;
  /** When this tab becomes active, restart the clip from the top so the
   * animation always plays from frame 0 rather than wherever the loop was. */
  active?: boolean | undefined;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video || !active) return;
    video.currentTime = 0;
    void video.play().catch(() => {
      // Autoplay can be blocked until interaction; the `autoPlay` attribute
      // and muted state cover the common case, so a rejected play() is fine.
    });
  }, [active]);

  // Several edges compose by intersecting their masks, which is what
  // `mask-composite: intersect` does — each listed edge fades independently.
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
