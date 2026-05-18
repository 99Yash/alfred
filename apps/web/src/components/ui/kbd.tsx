/**
 * Dimension-grammar Kbd primitive — keyboard shortcut chip.
 *
 * Tiny inline pill that sits next to nav rows and primary actions to hint at
 * the keyboard shortcut. Examples in the live UI: `⇧O` next to "New Chat",
 * `⌘K` next to "Search", `⌘↵` next to "Learn".
 *
 * Recipe pulled from dimension-design-reference-2026-05-18.md §2.15.
 */

import { type HTMLAttributes } from "react";
import { cn } from "~/lib/utils";

export function Kbd({ className, children, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center min-w-[18px] h-[18px] justify-center px-1 rounded-md",
        "border border-white/10 bg-white/[0.04]",
        "text-[11px] leading-none tabular text-white/60 font-sans",
        className,
      )}
      {...rest}
    >
      {children}
    </kbd>
  );
}
