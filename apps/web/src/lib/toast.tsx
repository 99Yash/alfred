import type { ReactNode } from "react";
import { toast } from "sonner";
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
 * Frosted toast — a translucent, blurred card with a hairline border and an
 * inset highlight, ported from dimension's `callToast`. Sits on top of the
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
          "flex w-fit items-center gap-3 rounded-xl px-3.5 py-2.5 backdrop-blur-xl",
          "border shadow-[0px_0px_0px_0.5px_rgba(0,0,0,0.2),0px_8px_24px_-8px_rgba(0,0,0,0.45),inset_0px_0px_0px_0.5px_rgba(255,255,255,0.06)]",
          type === "danger"
            ? "border-app-red-2/70 bg-app-red-1/80 text-app-red-4"
            : "border-app-fg-a1/50 bg-app-bg-2/80 text-app-fg-4",
        )}
      >
        {icon ? <span className="mt-0.5 shrink-0 self-start">{icon}</span> : null}
        <div className="flex flex-col gap-0.5">
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
              "ml-1 shrink-0 rounded-lg px-2 py-1 text-[12.5px] font-medium",
              "text-app-fg-5 transition-colors hover:bg-app-fg-a1/60",
              "outline-none focus-visible:ring-2 focus-visible:ring-app-fg-a2",
            )}
          >
            {action.label}
          </button>
        ) : null}
      </div>
    ),
    { duration },
  );
}
