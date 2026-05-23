import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export function Kbd({
  children,
  inline,
}: {
  children: ReactNode;
  inline?: boolean;
}) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center justify-center gap-0.5 h-[18px] px-1 rounded-md",
        "bg-vs-bg-2 text-vs-fg-3 font-sans text-[11px]",
        "shadow-[0_0_0_1px_rgba(0,0,0,0.05)]",
        inline && "mx-0.5",
      )}
    >
      {children}
    </kbd>
  );
}
