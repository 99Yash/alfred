import { ChevronRight } from "lucide-react";
import { cn } from "~/lib/utils";

export function SuggestionRow({ label, detail }: { label: string; detail: string }) {
  return (
    <button
      type="button"
      className={cn(
        "group w-full text-left rounded-xl px-2 py-2 -mx-0.5",
        "hover:bg-white/[0.07] transition-colors vs-press",
        "flex items-center gap-2.5",
        "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] leading-5 font-medium text-white">
          {label}
        </span>
        <span className="block truncate text-[11px] leading-4 text-white/55">{detail}</span>
      </span>
      <ChevronRight
        size={12}
        aria-hidden
        className="shrink-0 text-white/55 group-hover:text-white/80 transition-colors"
      />
    </button>
  );
}
