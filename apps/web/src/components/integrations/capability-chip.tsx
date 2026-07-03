import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export function CapabilityChip({ children }: { children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-8 items-center gap-2 rounded-full pr-3.5 pl-2",
        "bg-app-bg-1 text-[12.5px] font-medium text-app-fg-4 ring-1 ring-app-bg-3",
        "shadow-(--app-shadow-elevated)",
      )}
    >
      <span
        aria-hidden
        className="grid size-5 place-items-center rounded-md bg-app-purple-1 text-app-purple-4"
      >
        <Check size={11} strokeWidth={2.5} />
      </span>
      {children}
    </span>
  );
}
