import { GodRays } from "@paper-design/shaders-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * Hero sky that crossfades morning, midday, evening, and night with scroll `progress`.
 * `fixed`, not `sticky`: onboarding scrolls the document, and there `sticky`
 * under the `overflow-clip` wrapper stops pinning in Chrome.
 * `overflow-clip`, not `overflow-hidden`, so other descendants can still be sticky.
 */
export function HeroAtmosphere({
  children,
  className,
  progress = 0,
}: {
  children?: ReactNode | undefined;
  className?: string | undefined;
  /** Scroll progress 0..1 across the whole landing. Drives the sky cycle. */
  progress?: number | undefined;
}) {
  // Each layer peaks over an overlapping slice of the scroll range.
  const morning = bell(progress, 0.0, 0.22);
  const midday = bell(progress, 0.32, 0.22);
  const evening = bell(progress, 0.6, 0.18);
  const night = saturate(progress, 0.78, 0.95);

  const sun = 1 - saturate(progress, 0.3, 0.6);
  const lensFlare = bell(progress, 0.18, 0.16);
  // color-burn over the near-black night crushes to mud, so fade it out.
  const cloudShadow = 0.5 * (1 - night);

  return (
    <div className={cn("relative isolate overflow-clip", className)}>
      {/* Pinned to the viewport for the whole scroll. */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-20">
        <div className="relative size-full overflow-hidden">
          {/* L1: base tone, so we never paint void. */}
          <div className="landing-hero-sky absolute inset-0" />

          {/* L2: morning */}
          <div
            className="landing-sky-morning absolute inset-0 transition-opacity duration-300"
            style={{ opacity: morning }}
          />

          {/* L3: midday */}
          <div
            className="landing-sky-midday absolute inset-0 transition-opacity duration-300"
            style={{ opacity: midday }}
          />

          {/* L4: evening */}
          <div
            className="landing-sky-evening absolute inset-0 transition-opacity duration-300"
            style={{ opacity: evening }}
          />

          {/* L5: night */}
          <div
            className="landing-sky-night absolute inset-0 transition-opacity duration-500"
            style={{ opacity: night }}
          />

          {/* Cloud texture at color-burn (dimension's hero/shadow-bg.png). */}
          <img
            src="/images/landing/shadow-bg.png"
            alt=""
            aria-hidden
            className="pointer-events-none absolute inset-0 size-full object-cover mix-blend-color-burn transition-opacity duration-500 select-none"
            style={{ opacity: cloudShadow }}
          />

          {/* Rainbow lens flare at screen blend (dimension's hero/sun-halo.png). */}
          <img
            src="/images/landing/sun-halo.png"
            alt=""
            aria-hidden
            className="pointer-events-none absolute inset-0 size-full object-cover object-top-left mix-blend-screen transition-opacity duration-500 select-none"
            style={{ opacity: lensFlare }}
          />

          {/* Sun god rays. Screen blend only adds light. */}
          <div
            className="pointer-events-none absolute inset-0 mix-blend-screen transition-opacity duration-300"
            style={{ opacity: 0.45 * sun }}
          >
            <GodRays
              style={{ width: "100%", height: "100%" }}
              colorBack="#00000000"
              colorBloom="#ffd9a8"
              colors={["#ffe6c8aa", "#ffc88a55", "#ffb37a33"]}
              offsetX={0.85}
              offsetY={-0.85}
              spotty={0.6}
              midSize={0.15}
              midIntensity={0.18}
              density={0.06}
              intensity={0.35}
              bloom={0.5}
              speed={0.18}
            />
          </div>

          {/* Top mask keeps the announcement bar legible. */}
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-28"
            style={{
              background: "linear-gradient(180deg, rgba(0,0,0,0.18), transparent)",
            }}
          />
        </div>
      </div>

      <div className="relative z-10">{children}</div>
    </div>
  );
}

/** Triangle pulse: 1 at `center`, 0 beyond `halfWidth`. */
function bell(t: number, center: number, halfWidth: number): number {
  const d = Math.abs(t - center);

  if (d >= halfWidth) return 0;

  return 1 - d / halfWidth;
}

/** Linear ramp from 0 at `from` to 1 at `to`, clamped. */
function saturate(t: number, from: number, to: number): number {
  if (t <= from) return 0;

  if (t >= to) return 1;

  return (t - from) / (to - from);
}
