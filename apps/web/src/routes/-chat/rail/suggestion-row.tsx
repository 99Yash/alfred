import { Check, ChevronRight, Plus, X } from "lucide-react";
import { cn } from "~/lib/utils";

/**
 * A suggested-todo row (ADR-0050). `onAccept` promotes it (`suggested → open`);
 * the leading glyph is a `+` when accept is wired, a chevron on static previews.
 * `onComplete` marks it done directly (`suggested → done`) via a hover-revealed
 * check; `onDismiss` declines it (`suggested → dismissed`) via a hover-revealed
 * `×`. The three actions carry distinct accessible names so keyboard and
 * screen-reader users can tell "add to to-dos", "mark done", and "dismiss" apart.
 */
export function SuggestionRow({
  label,
  detail,
  onAccept,
  onComplete,
  onDismiss,
}: {
  label: string;
  detail: string;
  onAccept?: () => void;
  onComplete?: () => void;
  onDismiss?: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative -mx-0.5 flex items-start gap-1 rounded-xl p-2",
        "transition-colors hover:bg-white/[0.07]",
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
          "app-press flex min-w-0 flex-1 items-start gap-1.5 rounded-md text-left",
          "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
        )}
      >
        <span className="min-w-0 flex-1">
          {/* The title IS the todo. `title` attr exposes the full string on hover
              if it wraps past two lines, so nothing is unreadably clipped. */}
          <span
            title={label}
            className="line-clamp-2 block text-[12.5px] leading-5 font-medium [text-wrap:pretty] text-white"
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
              className="text-white/55 transition-colors group-hover:text-white"
            />
          ) : (
            <ChevronRight
              size={13}
              aria-hidden
              className="text-white/55 transition-colors group-hover:text-white/80"
            />
          )}
        </span>
      </button>
      {onComplete ? (
        <button
          type="button"
          onClick={onComplete}
          aria-label={`Mark done: ${label}`}
          className={cn(
            "app-press inline-flex size-6 shrink-0 items-center justify-center rounded-md",
            "text-white/45 transition-[color,background-color,opacity] hover:bg-white/10 hover:text-white",
            "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100",
            "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
          )}
        >
          <Check size={13} strokeWidth={2.5} aria-hidden />
        </button>
      ) : null}
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={`Dismiss suggestion: ${label}`}
          className={cn(
            "app-press inline-flex size-6 shrink-0 items-center justify-center rounded-md",
            "text-white/45 transition-[color,background-color,opacity] hover:bg-white/10 hover:text-white",
            "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100",
            "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
          )}
        >
          <X size={12} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
