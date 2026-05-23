import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * Triple-nested rounded bezel that frames product mockups like a real
 * device. Borrowed from firstquadrant.ai's landing — three concentric
 * borders + a soft inner gradient gives the mockup a "physical screen"
 * weight that a single rounded card can't.
 *
 *   outer  rounded-[3rem]  p-3
 *   middle rounded-[2.5rem] p-3   (gradient fill)
 *   inner  rounded-[2rem]   p-0   ← children render here, edge-to-edge
 *
 * Pass any mockup as children — the inner panel sets `overflow-hidden` so
 * rounded children clip cleanly to the bezel.
 */
export function DeviceBezel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "relative rounded-[3rem] border border-neutral-800/80 bg-neutral-950/40 p-3",
        "shadow-[0_40px_120px_-40px_rgba(0,0,0,0.6)]",
        className,
      )}
    >
      <div
        className={cn(
          "rounded-[2.5rem] border border-neutral-800/80 p-3",
          "bg-gradient-to-b from-neutral-900 to-neutral-900/50",
        )}
      >
        <div className="overflow-hidden rounded-[2rem] border border-neutral-800/80">
          {children}
        </div>
      </div>
    </div>
  );
}
