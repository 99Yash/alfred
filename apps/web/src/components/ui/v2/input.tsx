/**
 * App-grammar Input primitive.
 *
 * Same shadow stack as the white AppButton. Use `readOnly` to get the muted
 * `bg-app-bg-2` token-display variant (the "Project token" field on the
 * visitors.now /settings page).
 */

import type { InputHTMLAttributes, Ref } from "react";
import { cn } from "~/lib/utils";

interface AppInputProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement>;
}

export function AppInput({ className, readOnly, ref, ...rest }: AppInputProps) {
  return (
    <input
      ref={ref}
      readOnly={readOnly}
      className={cn(
        "h-9 w-full rounded-xl px-3 text-sm",
        "transition-shadow outline-none",
        "focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-app-background",
        "placeholder:text-app-fg-2",
        readOnly
          ? "cursor-default bg-app-bg-2 text-app-fg-3"
          : cn("bg-app-bg-1 text-app-fg-4", "app-elevated"),
        className,
      )}
      {...rest}
    />
  );
}
