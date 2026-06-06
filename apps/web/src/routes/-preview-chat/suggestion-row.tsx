import { ChevronRight, Plus } from "lucide-react";
import { cn } from "~/lib/utils";

/**
 * A suggested-todo row (ADR-0050). `onAccept` promotes it (`suggested → open`);
 * the leading glyph is a `+` when accept is wired, a chevron on static previews.
 */
export function SuggestionRow({
  label,
  detail,
  onAccept,
}: {
  label: string;
  detail: string;
  onAccept?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onAccept}
      aria-label={onAccept ? `Add suggestion: ${label}` : undefined}
      className={cn(
        "group w-full text-left rounded-xl px-2 py-2 -mx-0.5",
        "hover:bg-white/[0.07] transition-colors app-press",
        "flex items-center gap-2.5",
        "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] leading-5 font-medium text-white">
          {label}
        </span>
        {detail ? (
          <span className="block truncate text-[11px] leading-4 text-white/55">{detail}</span>
        ) : null}
      </span>
      {onAccept ? (
        <Plus
          size={13}
          aria-hidden
          className="shrink-0 text-white/55 group-hover:text-white transition-colors"
        />
      ) : (
        <ChevronRight
          size={12}
          aria-hidden
          className="shrink-0 text-white/55 group-hover:text-white/80 transition-colors"
        />
      )}
    </button>
  );
}
