import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export function Kbd({ children, inline }: { children: ReactNode; inline?: boolean }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] items-center justify-center gap-0.5 rounded-md px-1",
        "bg-app-bg-2 font-sans text-[11px] text-app-fg-3",
        "shadow-[0_0_0_1px_rgba(0,0,0,0.05)]",
        inline && "mx-0.5",
      )}
    >
      {children}
    </kbd>
  );
}
