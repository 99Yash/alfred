import { ChevronRight, Plus, X } from "lucide-react";
import { cn } from "~/lib/utils";

/**
 * A suggested-todo row (ADR-0050). `onAccept` promotes it (`suggested → open`);
 * the leading glyph is a `+` when accept is wired, a chevron on static previews.
 * `onDismiss` declines it (`suggested → dismissed`) via a hover-revealed `×`.
 */
export function SuggestionRow({
  label,
  detail,
  onAccept,
  onDismiss,
}: {
  label: string;
  detail: string;
  onAccept?: () => void;
  onDismiss?: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative flex items-start gap-1 rounded-xl px-2 py-2 -mx-0.5",
        "hover:bg-white/[0.07] transition-colors",
      )}
    >
      <button
        type="button"
        onClick={onAccept}
        // The accessible name must lead with — and contain — the button's full
        // visible text (label + detail) so it passes label-content-name-mismatch
        // and voice-control users can say what they see; the action follows.
        aria-label={
          onAccept ? `${detail ? `${label} ${detail}` : label}, add as a to-do` : undefined
        }
        className={cn(
          "flex min-w-0 flex-1 items-start gap-1.5 rounded-md text-left app-press",
          "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
        )}
      >
        <span className="min-w-0 flex-1">
          {/* The title IS the todo. `title` attr exposes the full string on hover
              if it wraps past two lines, so nothing is unreadably clipped. */}
          <span
            title={label}
            className="block line-clamp-2 text-[12.5px] leading-5 font-medium text-white [text-wrap:pretty]"
          >
            {label}
          </span>
          {/* `detail` is a hard-fact fragment (amount / deadline / decision), not a
              body sentence — render it as one compact, dimmed meta line, never a wall. */}
          {detail ? (
            <span
              title={detail}
              className="mt-0.5 block truncate text-[11px] leading-4 text-white/45 tabular-nums"
            >
              {detail}
            </span>
          ) : null}
        </span>
        {/* Glyph sits in a 24px box matching the dismiss `×` so the two controls
            share a footprint and their centers line up — even when the title wraps. */}
        <span className="flex size-6 shrink-0 items-center justify-center">
          {onAccept ? (
            <Plus
              size={14}
              aria-hidden
              className="text-white/55 group-hover:text-white transition-colors"
            />
          ) : (
            <ChevronRight
              size={13}
              aria-hidden
              className="text-white/55 group-hover:text-white/80 transition-colors"
            />
          )}
        </span>
      </button>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={`Dismiss suggestion: ${label}`}
          className={cn(
            "shrink-0 inline-flex size-6 items-center justify-center rounded-md app-press",
            "text-white/45 hover:bg-white/10 hover:text-white transition-[color,background-color,opacity]",
            "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100",
            "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
          )}
        >
          <X size={12} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
