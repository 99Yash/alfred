import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * Page-wide backdrop for the marketing landing — pure black with a faint
 * square grid texture. FQ-style: the "atmosphere" is all typography and
 * spacing, not gradients or animated meshes.
 *
 * Grid is drawn as a CSS `background-image` so it tiles cheaply at any size
 * and scales with the viewport. Two layers (40px major + 8px minor) to give
 * the texture some depth without becoming a focal point.
 */
export function LandingBackground({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      // Lock Open Runde in landing scope — explicit family beats relying on
      // the body --font-sans cascade. tracking-[-0.012em] mirrors visitors.now's
      // -0.32px / 16px body tracking; headlines tighten further on their own.
      style={{
        fontFamily: '"Open Runde", Inter, ui-sans-serif, system-ui, sans-serif',
      }}
      className={cn("relative isolate bg-[#0a0a0a]", "tracking-[-0.012em]", className)}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          backgroundImage: [
            // Major 80px grid — very faint
            "linear-gradient(to right, rgba(255,255,255,0.035) 1px, transparent 1px)",
            "linear-gradient(to bottom, rgba(255,255,255,0.035) 1px, transparent 1px)",
          ].join(", "),
          backgroundSize: "80px 80px, 80px 80px",
        }}
      />
      {/* Soft top vignette so the announcement bar reads cleanly */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-64 bg-gradient-to-b from-black/60 to-transparent"
      />
      {children}
    </div>
  );
}
