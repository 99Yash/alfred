/**
 * Dimension-grammar Kbd primitive — keyboard shortcut chip.
 *
 * Tiny inline pill that sits next to nav rows and primary actions to hint at
 * the keyboard shortcut. Examples in the live UI: `⇧O` next to "New Chat",
 * `⌘K` next to "Search", `⌘↵` next to "Learn".
 */

import { type HTMLAttributes } from "react";
import { cn } from "~/lib/utils";

export function Kbd({ className, children, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-md px-1",
        "border border-white/10 bg-white/[0.04]",
        "tabular font-sans text-[11px] leading-none text-white/60",
        className,
      )}
      {...rest}
    >
      {children}
    </kbd>
  );
}
