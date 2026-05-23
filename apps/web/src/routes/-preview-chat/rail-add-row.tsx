import { Plus } from "lucide-react";
import { cn } from "~/lib/utils";

export function RailAddRow({ placeholder }: { placeholder: string }) {
  return (
    <button
      type="button"
      className={cn(
        "group w-full text-left rounded-xl px-2 py-2 -mx-0.5",
        "border border-dashed border-vs-bg-3 hover:border-vs-fg-2",
        "transition-colors flex items-center gap-2",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
      )}
    >
      <Plus
        size={12}
        aria-hidden
        className="text-vs-fg-2 group-hover:text-vs-fg-4 transition-colors"
      />
      <span className="text-[12px] text-vs-fg-2 group-hover:text-vs-fg-3 transition-colors">
        {placeholder}
      </span>
    </button>
  );
}
