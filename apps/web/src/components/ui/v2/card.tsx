/** App Card (archive/visitors-now/design-notes.md §"Card"): no border, shadow only. */

import type { HTMLAttributes, Ref } from "react";
import { cn } from "~/lib/utils";

interface AppCardProps extends HTMLAttributes<HTMLDivElement> {
  /** 20px padding, default true. Turn off for an embedded list or chart. */
  padded?: boolean | undefined;
  /** Hover and focus styles for a fully clickable card. */
  interactive?: boolean | undefined;
  ref?: Ref<HTMLDivElement> | undefined;
}

export function AppCard({ className, padded = true, interactive, ref, ...rest }: AppCardProps) {
  return (
    <div
      ref={ref}
      className={cn(
        "w-full overflow-hidden rounded-2xl bg-app-bg-1",
        /* Theme-aware: a black shadow is invisible on the dark background. */
        "shadow-[var(--app-shadow-elevated)]",
        padded && "p-5",
        interactive &&
          cn(
            "cursor-pointer transition-shadow",
            "hover:shadow-[var(--app-shadow-elevated-hover)]",
            "app-focus",
          ),
        className,
      )}
      {...rest}
    />
  );
}
