import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * One stacked feed in the rail's tab grid. Inactive slots fade + lift +
 * blur, and lose pointer events so they don't intercept clicks meant for
 * the visible feed below. Crossfade timing matches the landing showcase.
 */
export function RailSlot({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div
      aria-hidden={!active}
      className={cn(
        "[grid-area:1/1] transition-[opacity,transform,filter] duration-300 ease-out",
        active ? "opacity-100 z-10" : "opacity-0 pointer-events-none blur-[2px]",
      )}
      style={{
        transform: active ? "translateY(0) scale(1)" : "translateY(8px) scale(0.985)",
      }}
    >
      {children}
    </div>
  );
}
