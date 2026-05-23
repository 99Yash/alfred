import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export function CapabilityChip({ children }: { children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full h-8 pl-2 pr-3.5",
        "bg-vs-bg-1 ring-1 ring-vs-bg-3 text-[12.5px] font-medium text-vs-fg-4",
        "shadow-[var(--vs-shadow-elevated)]",
      )}
    >
      <span
        aria-hidden
        className="grid size-5 place-items-center rounded-md bg-vs-purple-1 text-vs-purple-4"
      >
        <Check size={11} strokeWidth={2.5} />
      </span>
      {children}
    </span>
  );
}
