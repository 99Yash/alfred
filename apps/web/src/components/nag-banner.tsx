import { TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

interface NagBannerProps {
  /** Inline copy explaining what's wrong; may contain emphasis spans. */
  message: ReactNode;
  /** Label for the primary reconnect action. */
  actionLabel: string;
  /** Runs the full-page redirect that resolves the gap. */
  onAction: () => void;
  /** Hides the banner for the rest of the session. */
  onDismiss: () => void;
}

/**
 * Shared card for the integration nag bars (`ScopeGapBanner`,
 * `GithubReconnectBanner`). A self-contained, centered notice — the shell
 * floats it just below the header in an absolutely-positioned layer, so it
 * never adds to the chat surface's layout height. Colors come from the
 * theme-aware `--app-amber-*` / `--app-fg-*` tokens so it stays legible in
 * both light and dark. Keeping the chrome here means the two nags can't drift.
 */
export function NagBanner({ message, actionLabel, onAction, onDismiss }: NagBannerProps) {
  return (
    <div
      role="alert"
      className={cn(
        "pointer-events-auto flex w-full max-w-2xl items-center gap-3 rounded-xl px-3.5 py-2.5",
        "border border-app-amber-2 bg-app-amber-1 text-app-fg-4 backdrop-blur-sm",
        "shadow-[0_8px_24px_-12px_rgba(0,0,0,0.25)]",
      )}
    >
      <TriangleAlert size={16} className="shrink-0 text-app-amber-4" />
      <p className="min-w-0 flex-1 text-[13px] leading-snug text-pretty">{message}</p>
      <button
        type="button"
        onClick={onAction}
        className={cn(
          "shrink-0 rounded-full px-3 py-1 text-[13px] font-medium",
          "bg-amber-500 text-amber-950",
          "transition-[background-color,transform] duration-150 hover:bg-amber-400 active:scale-[0.96]",
        )}
      >
        {actionLabel}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className={cn(
          "shrink-0 rounded-full p-1 text-app-fg-3",
          "transition-[color,transform] duration-150 hover:text-app-fg-4 active:scale-[0.96]",
        )}
        aria-label="Dismiss"
      >
        <X size={15} />
      </button>
    </div>
  );
}
