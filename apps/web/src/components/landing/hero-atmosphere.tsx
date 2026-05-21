import { GodRays } from "@paper-design/shaders-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * Atmospheric hero backdrop with a scroll-driven day → evening → night cycle.
 *
 * Four sky layers are stacked inside a viewport-pinned `fixed inset-0` shell
 * so the gradient stays pinned to the viewport while sections rise through
 * it (the parallax). Each layer's `opacity` is driven by the `progress` prop
 * (0..1) so as the user scrolls through the seven capability sections + CTA
 * + footer, the sky crossfades from morning blue to peach evening to
 * deep-blue night.
 *
 * `fixed` (rather than `sticky`) is load-bearing: HeroAtmosphere is used
 * both by the landing (which has its own internal scroll root) and by the
 * onboarding (which scrolls on the document). `sticky top-0` works in the
 * landing case but breaks under the `overflow-clip` wrapper when the
 * scroll happens on the document — Chrome stops pinning and the sky
 * scrolls out of view past the first viewport. `fixed` is viewport-relative
 * in both cases and the `pointer-events-none` keeps it from intercepting
 * clicks on foreground content.
 *
 * `overflow-clip` on the wrapper is intentional — `overflow-hidden` would
 * make this a scroll-containing-block and break sticky on OTHER descendants
 * (the shared locale ribbon, etc.).
 */
export function HeroAtmosphere({
  children,
  className,
  progress = 0,
}: {
  children?: ReactNode;
  className?: string;
  /** Scroll progress 0..1 across the whole landing. Drives the sky cycle. */
  progress?: number;
}) {
  // Build a `t`-curve for each sky layer. Each layer peaks (opacity 1) over
  // a slice of the scroll range and fades to 0 outside it. The slices are
  // staggered with overlap so we get smooth crossfades, not hard cuts.
  const morning = bell(progress, 0.0, 0.22);
  const midday = bell(progress, 0.32, 0.22);
  const evening = bell(progress, 0.6, 0.18);
  const night = saturate(progress, 0.78, 0.95);

  // Sun-halo intensity follows a morning-to-evening arc. It peaks slightly
  // before midday and fades out by evening so the "sun has set" reads.
  const sun = saturate(progress, 0.0, 0.55);
  // Rainbow lens-flare reaches its peak in the late-morning window
  // (sun-catches-the-lens moment) and fades by midday. Bell-curve so it
  // both fades in AND back out smoothly. Inverted from the sky-layer
  // bell helpers — broader curve centered on the second/third capability.
  const lensFlare = bell(progress, 0.18, 0.16);

  return (
    <div className={cn("relative isolate overflow-clip", className)}>
      {/* Viewport-pinned backdrop. `fixed inset-0` keeps the sky painted at
        * the viewport across the entire scroll length without depending on
        * whether the ancestor establishes a scroll-port. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-20"
      >
        <div className="relative h-full w-full overflow-hidden">
          {/* L1 — base default tone so we never paint void. */}
          <div className="landing-hero-sky absolute inset-0" />

          {/* L2 — morning: cool dawn blues */}
          <div
            className="landing-sky-morning absolute inset-0 transition-opacity duration-300"
            style={{ opacity: morning }}
          />

          {/* L3 — midday: bright clear blue. */}
          <div
            className="landing-sky-midday absolute inset-0 transition-opacity duration-300"
            style={{ opacity: midday }}
          />

          {/* L4 — evening: peach + violet horizon. */}
          <div
            className="landing-sky-evening absolute inset-0 transition-opacity duration-300"
            style={{ opacity: evening }}
          />

          {/* L5 — night: deep indigo with a starfield vignette. */}
          <div
            className="landing-sky-night absolute inset-0 transition-opacity duration-500"
            style={{ opacity: night }}
          />

          {/* Lens-flare rainbow halo — the camera catches the sun during
            * late-morning. Two layered conic + radial rings produce the
            * chromatic-aberration look; both are heavily blurred so they
            * read as soft light spectra, not graphic decoration. Inspired
            * by dimension's blurred-oval flare at home.html:2376. */}
          <div
            className="pointer-events-none absolute -right-24 top-[-10%] mix-blend-screen transition-opacity duration-500"
            style={{ opacity: lensFlare }}
            aria-hidden
          >
            <div className="relative">
              {/* Outer rainbow ring (chromatic spread) */}
              <div className="landing-lens-flare-rainbow" />
              {/* Inner white-hot core */}
              <div className="landing-lens-flare-core" />
            </div>
          </div>

          {/* Sun halo via paper-shader GodRays — brightest in the morning,
            * gone by evening. Sits in screen-blend mode so it just adds
            * light, never darkens. */}
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

          {/* Top gradient mask — keeps the announcement bar legible. */}
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-28"
            style={{
              background:
                "linear-gradient(180deg, rgba(0,0,0,0.18), transparent)",
            }}
          />
        </div>
      </div>

      <div className="relative z-10">{children}</div>
    </div>
  );
}

/**
 * Triangular pulse — 0 outside [center-halfWidth, center+halfWidth], peaks
 * at `center` with value 1. Used so each sky layer fades in and back out
 * cleanly with overlap onto the next one.
 */
function bell(t: number, center: number, halfWidth: number): number {
  const d = Math.abs(t - center);
  if (d >= halfWidth) return 0;
  return 1 - d / halfWidth;
}

/**
 * Linear saturation from 0 at `from` to 1 at `to`, clamped outside. Used
 * for the night layer (only ramps up at the end) and the sun-halo (ramps
 * down).
 */
function saturate(t: number, from: number, to: number): number {
  if (t <= from) return 0;
  if (t >= to) return 1;
  return (t - from) / (to - from);
}
