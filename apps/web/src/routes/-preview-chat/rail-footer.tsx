import { ArrowRight, Sparkles } from "lucide-react";
import { cn } from "~/lib/utils";

export function RailFooter() {
  return (
    <div className="shrink-0 p-3 border-t border-vs-bg-3/60">
      <button
        type="button"
        className={cn(
          "w-full inline-flex items-center justify-between gap-2 rounded-xl h-10 px-3",
          "text-sm font-medium",
          "text-[var(--vs-accent-fg)]",
          "bg-[image:var(--vs-cta-bg)]",
          "shadow-[var(--vs-button-primary-shadow)]",
          "vs-press transition-[box-shadow,transform,filter]",
          "hover:brightness-[1.06]",
          "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
        )}
      >
        <span className="inline-flex items-center gap-2">
          <Sparkles size={13} aria-hidden />
          Morning briefing
        </span>
        <ArrowRight size={14} aria-hidden />
      </button>
    </div>
  );
}
