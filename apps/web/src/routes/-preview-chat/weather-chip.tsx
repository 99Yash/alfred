import { Sun } from "lucide-react";
import { cn } from "~/lib/utils";

/**
 * Compact weather widget. Dimension placed `Bhubaneswar 29°` in the rail's
 * top-right; we mirror that with a subtle surface plate that sits on top of
 * the atmosphere glow. Mock data only — wiring to a real weather provider
 * is out of scope for the rail preview.
 */
export function WeatherChip() {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full h-7 pl-2 pr-2.5",
        "bg-vs-bg-1/70 ring-1 ring-vs-bg-3/70 backdrop-blur",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
      )}
    >
      <Sun size={12} className="text-vs-amber-4" aria-hidden />
      <span className="text-[12px] font-medium text-vs-fg-4 tabular-nums">27°</span>
      <span aria-hidden className="h-3 w-px bg-vs-bg-3/80" />
      <span className="text-[11px] text-vs-fg-2">Bengaluru</span>
    </div>
  );
}
