import { cn } from "~/lib/utils";

/** Indigo glow behind the hero mockup. Needs a `relative` parent. */
export function AuroraGlow({
  className,
  intensity = "default",
}: {
  className?: string | undefined;
  intensity?: "default" | "subtle" | undefined;
}) {
  const opacity = intensity === "subtle" ? 0.5 : 0.85;

  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-0 -z-10",
        // Extends past the top, so the mockup rises out of the haze.
        "-top-32 h-[120%]",
        className,
      )}
      style={{ opacity }}
    >
      {/* Wide halo. The gradient does the softening; a small blur stays under mobile GPU limits. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 50% at 50% 35%, rgba(99, 102, 241, 0.35) 0%, rgba(99, 102, 241, 0.08) 45%, transparent 70%)",
          filter: "blur(8px)",
        }}
      />
      {/* Violet hot-spot */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(35% 30% at 50% 20%, rgba(167, 139, 250, 0.4) 0%, rgba(139, 92, 246, 0.12) 50%, transparent 75%)",
          filter: "blur(9px)",
        }}
      />
    </div>
  );
}
