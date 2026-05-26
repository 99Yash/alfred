import { Plus } from "lucide-react";
import { cn } from "~/lib/utils";

export function RailAddRow({ placeholder }: { placeholder: string }) {
  return (
    <button
      type="button"
      className={cn(
        "group w-full text-left rounded-xl px-2 py-2 -mx-0.5",
        "border border-dashed border-white/15 hover:border-white/35",
        "transition-colors flex items-center gap-2",
        "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
      )}
    >
      <Plus
        size={12}
        aria-hidden
        className="text-white/60 group-hover:text-white transition-colors"
      />
      <span className="text-[12px] text-white/65 group-hover:text-white/90 transition-colors">
        {placeholder}
      </span>
    </button>
  );
}
