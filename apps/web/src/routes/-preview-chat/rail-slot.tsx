import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * One stacked feed in the rail's tab grid. Inactive slots fade + lift +
 * blur, and lose pointer events so they don't intercept clicks meant for
 * the visible feed below. Crossfade timing matches the landing showcase.
 *
 * Only the ACTIVE slot stays in normal flow — inactive slots go
 * `absolute inset-0 overflow-hidden`, so they overlay the same cell for
 * the crossfade but contribute nothing to the grid row's height or to
 * the scroll container's overflow. Without this, the row sized to the
 * MAX of all feeds: open a long Gmail thread in the inbox reader, flip
 * to To do, and the (invisible) reader kept propping up a phantom
 * scrollbar under a feed with three rows in it.
 */
export function RailSlot({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div
      aria-hidden={!active}
      className={cn(
        "[grid-area:1/1] transition-[opacity,transform,filter] duration-300 ease-out",
        active
          ? "opacity-100 z-10"
          : "absolute inset-0 overflow-hidden opacity-0 pointer-events-none blur-[2px]",
      )}
      style={{
        transform: active ? "translateY(0) scale(1)" : "translateY(8px) scale(0.985)",
      }}
    >
      {children}
    </div>
  );
}
