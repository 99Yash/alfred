import { type ReactNode } from "react";
import { cn } from "~/lib/utils";

/** Small bordered pill above hero headlines. The styleguide imports this same component. */
export function EyebrowChip({
  children,
  icon,
  accent = "neutral",
}: {
  children: ReactNode;
  icon?: ReactNode | undefined;
  accent?: "neutral" | "emerald" | "indigo" | "amber" | undefined;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1",
        "text-[12px] font-medium tracking-tight",
        "border",
        accent === "emerald" && "border-emerald-500/25 bg-emerald-500/[0.07] text-emerald-300",
        accent === "indigo" && "border-indigo-400/25 bg-indigo-400/[0.07] text-indigo-200",
        accent === "amber" && "border-amber-400/25 bg-amber-400/[0.07] text-amber-200",
        accent === "neutral" && "border-neutral-800 bg-neutral-900/60 text-neutral-300",
      )}
    >
      {icon}
      <span>{children}</span>
    </span>
  );
}
