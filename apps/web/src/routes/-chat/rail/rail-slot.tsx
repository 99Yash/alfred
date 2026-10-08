import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * One feed in the rail's tab grid. Inactive slots fade out and are `absolute`,
 * so a hidden long feed cannot prop up the row height and add a phantom scrollbar.
 */
export function RailSlot({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div
      // `inert`, not `aria-hidden`: hidden feeds hold focusable controls (axe `aria-hidden-focus`).
      inert={!active}
      className={cn(
        "transition-[opacity,transform,filter] duration-300 ease-out [grid-area:1/1]",
        active
          ? "z-10 opacity-100"
          : "pointer-events-none absolute inset-0 overflow-hidden opacity-0 blur-[2px]",
      )}
      style={{
        transform: active ? "translateY(0) scale(1)" : "translateY(8px) scale(0.985)",
      }}
    >
      {children}
    </div>
  );
}
