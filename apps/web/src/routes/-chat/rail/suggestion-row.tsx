import { Check, ChevronRight, Plus, X } from "lucide-react";
import { cn } from "~/lib/utils";

/**
 * A suggested todo (ADR-0050). Accept: `suggested → open`; check: `→ done`; `×`: `→ dismissed`.
 * Each action has its own accessible name.
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
  onAccept?: (() => void) | undefined;
  onComplete?: (() => void) | undefined;
  onDismiss?: (() => void) | undefined;
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
        // Lead with the visible text (label-content-name-mismatch), then the action.
        aria-label={
          onAccept ? `${detail ? `${label} ${detail}` : label}, add as a to-do` : undefined
        }
        className={cn(
          "app-press flex min-w-0 flex-1 items-start gap-1.5 rounded-md text-left",
          "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
        )}
      >
        <span className="min-w-0 flex-1">
          {/* `title` shows the full text if it clips. */}
          <span
            title={label}
            className="line-clamp-2 block text-[12.5px] leading-5 font-medium text-pretty text-white"
          >
            {label}
          </span>
          {/* A short fact (amount, deadline), one dimmed line. */}
          {detail ? (
            <span
              title={detail}
              className="mt-0.5 block truncate text-[11px] leading-4 text-white/45 tabular-nums"
            >
              {detail}
            </span>
          ) : null}
        </span>
        {/* 24px box, same as the `×`, so their centers align. */}
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
