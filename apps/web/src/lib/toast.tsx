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
}: CallToastOptions): string | number {
  return toast.custom(
    () => (
      <div
        className={cn(
          "flex w-fit items-start gap-2.5 rounded-xl px-3.5 py-2.5 backdrop-blur-xl",
          "border shadow-[0px_0px_0px_0.5px_rgba(0,0,0,0.2),0px_8px_24px_-8px_rgba(0,0,0,0.45),inset_0px_0px_0px_0.5px_rgba(255,255,255,0.06)]",
          type === "danger"
            ? "border-vs-red-2/70 bg-vs-red-1/80 text-vs-red-4"
            : "border-vs-fg-a1/50 bg-vs-bg-2/80 text-vs-fg-4",
        )}
      >
        {icon ? <span className="mt-0.5 shrink-0">{icon}</span> : null}
        <div className="flex flex-col gap-0.5">
          <span className="text-[13px] font-medium leading-snug">{message}</span>
          {description ? (
            <span className="text-[12px] leading-snug text-vs-fg-3">{description}</span>
          ) : null}
        </div>
      </div>
    ),
    { duration },
  );
}
