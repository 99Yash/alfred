import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export function FauxControl({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg bg-vs-bg-1",
        "shadow-[0_0_0_1px_rgba(0,0,0,0.05)]",
        "h-8 px-2.5 text-[12.5px] font-medium text-vs-fg-4",
        className,
      )}
    >
      {children}
    </span>
  );
}
