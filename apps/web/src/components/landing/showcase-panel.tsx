import { useEffect, useRef } from "react";
import { cn } from "~/lib/utils";

/**
 * Media helper for the hero showcase tabs. Each tab's content is a
 * self-contained, full-bleed clip that fills the device bezel — the bezel's
 * fixed aspect (`aspect-[1.29/1]` in HeroShowcase) keeps every tab the same
 * size so the crossfade never jumps. `object-top` anchors the meaningful
 * content at the top and crops only any empty/overflow tail.
 *
 * (These clips are brand-stopgaps sourced from dimension's site; the plan is
 * to replace them with Alfred-branded clips rendered in Open Runde — see the
 * Remotion video package.)
 */

/** Full-bleed looping product clip. Muted + autoPlay + loop + playsInline is
 * the standard recipe for a silent ambient hero clip that also satisfies
 * mobile autoplay policies. */
export function ShowcaseVideo({
  src,
  label,
  className,
  objectPosition = "top",
  active = true,
}: {
  src: string;
  /** Accessible description of what the clip shows. */
  label: string;
  className?: string;
  objectPosition?: "top" | "center";
  /** When this tab becomes active, restart the clip from the top so the
   * animation always plays from frame 0 rather than wherever the loop was. */
  active?: boolean;
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

  return (
    <video
      ref={ref}
      className={cn("h-full w-full object-cover", className)}
      style={{ objectPosition }}
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
