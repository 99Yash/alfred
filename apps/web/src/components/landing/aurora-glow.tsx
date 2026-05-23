import { cn } from "~/lib/utils";

/**
 * Subtle violet/indigo radial glow that sits behind the hero product mockup.
 * Dark-theme adaptation of visitors.now's hero aurora — they use a bright
 * violet on white; ours is deeper indigo on black so it reads as
 * "evening" rather than "daylight."
 *
 * Two stacked radials:
 *   • a wide indigo halo for the overall ambient
 *   • a tighter violet hot-spot near the top edge of the mockup
 *
 * Pointer-events-none and absolutely positioned — must be a child of a
 * `relative` parent that wraps the mockup.
 */
export function AuroraGlow({
  className,
  intensity = "default",
}: {
  className?: string;
  intensity?: "default" | "subtle";
}) {
  const opacity = intensity === "subtle" ? 0.5 : 0.85;

  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-0 -z-10",
        // The glow sits behind the mockup and extends past its top edge,
        // so the mockup looks like it's emerging from a colored haze.
        "-top-32 h-[120%]",
        className,
      )}
      style={{ opacity }}
    >
      {/* Wide ambient indigo halo. blur radius kept modest (28px) — the
       * gradient already softens naturally, and large blurs (>40px) burn
       * GPU memory on mobile without much added effect. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 50% at 50% 35%, rgba(99, 102, 241, 0.35) 0%, rgba(99, 102, 241, 0.08) 45%, transparent 70%)",
          filter: "blur(28px)",
        }}
      />
      {/* Tighter violet hot-spot near the top of the mockup */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(35% 30% at 50% 20%, rgba(167, 139, 250, 0.4) 0%, rgba(139, 92, 246, 0.12) 50%, transparent 75%)",
          filter: "blur(44px)",
        }}
      />
    </div>
  );
}
