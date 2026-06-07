import { X } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { getLocalStorageItem } from "~/lib/storage";
import { cn } from "~/lib/utils";

interface CallToastOptions {
  message: string;
  description?: string;
  /** `default` is the frosted neutral card; `danger` tints it red. */
  type?: "default" | "danger";
  /** Auto-dismiss in ms. */
  duration?: number;
  icon?: ReactNode;
  /**
   * Optional inline action (e.g. "Undo"). Clicking it runs `onClick` and
   * dismisses the toast. Pair with a `duration` so the window matches the
   * caller's deferred commit.
   */
  action?: { label: string; onClick: () => void };
}

/**
 * Resolve the app-grammar theme attribute the same way `<AppThemed>` does.
 * sonner renders the toast outside the themed subtree, so without this the
 * card's `--app-*` tokens fall back to the light `:root` values and a dark
 * shell gets a jarring white card. `undefined` = system — let the `@media`
 * block in `index.css` resolve it.
 */
function appThemeAttr(): "dark" | "light" | undefined {
  const mode = getLocalStorageItem("app-theme");
  return mode === "dark" || mode === "light" ? mode : undefined;
}

/**
 * Frosted toast — a translucent, blurred card with a theme-aware hairline and
 * a soft drop, ported from dimension's `callToast`. Sits on top of the
 * `sonner` <Toaster> already mounted in `__root`. Use for low-stakes
 * notifications (turn finished, copied) and recoverable errors.
 */
export function callToast({
  message,
  description,
  type = "default",
  duration = 5000,
  icon,
  action,
}: CallToastOptions): string | number {
  return toast.custom(
    (id) => (
      <div
        className={cn(
          "app app-toast pointer-events-auto flex w-full min-w-[17rem] max-w-sm items-start gap-2.5 rounded-2xl px-3 py-2.5",
          type === "danger" && "app-toast--danger",
        )}
        data-app-theme={appThemeAttr()}
      >
        {icon ? (
          <span className="app-toast-icon mt-px grid size-7 shrink-0 place-items-center rounded-full">
            {icon}
          </span>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
          <span className="text-[13px] font-medium leading-snug">{message}</span>
          {description ? (
            <span className="text-[12px] leading-snug text-app-fg-3">{description}</span>
          ) : null}
        </div>
        {action ? (
          <button
            type="button"
            onClick={() => {
              action.onClick();
              toast.dismiss(id);
            }}
            className={cn(
              "-my-0.5 shrink-0 self-center rounded-lg px-2.5 py-1 text-[12.5px] font-medium",
              "text-app-fg-4 transition-colors hover:bg-app-bg-a2",
              "outline-none focus-visible:ring-2 focus-visible:ring-app-fg-a2",
            )}
          >
            {action.label}
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => toast.dismiss(id)}
          className={cn(
            "-mr-0.5 -mt-0.5 shrink-0 self-start rounded-lg p-1",
            "text-app-fg-2 transition-colors hover:bg-app-bg-a2 hover:text-app-fg-4",
            "outline-none focus-visible:ring-2 focus-visible:ring-app-fg-a2",
          )}
        >
          <X size={14} />
        </button>
      </div>
    ),
    { duration },
  );
}
