import { ChevronRight } from "lucide-react";
import { cn } from "~/lib/utils";

export function SuggestionRow({ label, detail }: { label: string; detail: string }) {
  return (
    <button
      type="button"
      className={cn(
        "group w-full text-left rounded-xl px-2 py-2 -mx-0.5",
        "hover:bg-vs-bg-a2 transition-colors vs-press",
        "flex items-center gap-2.5",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] leading-5 font-medium text-vs-fg-4">
          {label}
        </span>
        <span className="block truncate text-[11px] leading-4 text-vs-fg-2">{detail}</span>
      </span>
      <ChevronRight
        size={12}
        aria-hidden
        className="shrink-0 text-vs-fg-2 group-hover:text-vs-fg-3 transition-colors"
      />
    </button>
  );
}
