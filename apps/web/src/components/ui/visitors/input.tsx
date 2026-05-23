/**
 * Visitors-now-grammar Input primitive.
 *
 * Same shadow stack as the white VsButton. Use `readOnly` to get the muted
 * `bg-vs-bg-2` token-display variant (the "Project token" field on the
 * visitors.now /settings page).
 */

import type { InputHTMLAttributes, Ref } from "react";
import { cn } from "~/lib/utils";

interface VsInputProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement>;
}

export function VsInput({ className, readOnly, ref, ...rest }: VsInputProps) {
  return (
    <input
      ref={ref}
      readOnly={readOnly}
      className={cn(
        "w-full h-9 px-3 text-sm rounded-full",
        "outline-none transition-shadow",
        "focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-vs-background",
        "placeholder:text-vs-fg-2",
        readOnly
          ? "bg-vs-bg-2 text-vs-fg-3 cursor-default"
          : cn("bg-vs-bg-1 text-vs-fg-4", "vs-elevated"),
        className,
      )}
      {...rest}
    />
  );
}
