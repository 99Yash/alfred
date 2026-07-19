import { type ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * Small bordered pill rendered above hero headlines. Four accents — neutral,
 * indigo, emerald, amber — each a border/bg/text triple, paired with an optional
 * leading icon or status dot.
 *
 * Single owner for both the production landing hero and the styleguide catalog:
 * the styleguide imports this real component instead of copying it, so a restyle
 * (new accent, retinted triple) can't drift the design-system reference away from
 * production.
 */
export function EyebrowChip({
  children,
  icon,
  accent = "neutral",
}: {
  children: ReactNode;
  icon?: ReactNode;
  accent?: "neutral" | "emerald" | "indigo" | "amber";
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
