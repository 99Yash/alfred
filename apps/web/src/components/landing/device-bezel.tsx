import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/** Three nested rounded borders (from firstquadrant.ai). Children fill the inner panel and clip to it. */
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
          "bg-linear-to-b from-neutral-900 to-neutral-900/50",
        )}
      >
        <div className="relative overflow-hidden rounded-[2rem] border border-neutral-800/80">
          {children}
          {/* Glass: a vignette softens bright clips at the dark edge, plus a faint sheen. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[inherit]"
            style={{
              boxShadow:
                "inset 0 0 0 1px rgba(255,255,255,0.06), inset 0 2px 24px rgba(0,0,0,0.28), inset 0 -18px 40px -20px rgba(0,0,0,0.45)",
            }}
          />
        </div>
      </div>
    </div>
  );
}
