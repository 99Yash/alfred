import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/** Black landing backdrop with a faint 80px CSS grid. */
export function LandingBackground({
  children,
  className,
}: {
  children?: ReactNode | undefined;
  className?: string | undefined;
}) {
  return (
    <div
      // Set Open Runde explicitly; body tracking matches visitors.now (-0.32px at 16px).
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
            "linear-gradient(to right, rgba(255,255,255,0.035) 1px, transparent 1px)",
            "linear-gradient(to bottom, rgba(255,255,255,0.035) 1px, transparent 1px)",
          ].join(", "),
          backgroundSize: "80px 80px, 80px 80px",
        }}
      />
      {/* Top vignette keeps the announcement bar legible */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-64 bg-linear-to-b from-black/60 to-transparent"
      />
      {children}
    </div>
  );
}
