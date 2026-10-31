/** Keyboard shortcut chip. */

import type { HTMLAttributes } from "react";
import { cn } from "~/lib/utils";

export function Kbd({ className, children, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-control-sm px-1",
        "border border-app-fg-a1/40 bg-app-bg-1",
        "tabular font-sans text-[11px] leading-none text-app-fg-3",
        className,
      )}
      {...rest}
    >
      {children}
    </kbd>
  );
}
