/** App Input. `readOnly` gives the muted token-display look. */

import type { InputHTMLAttributes, Ref } from "react";
import { cn } from "~/lib/utils";

interface AppInputProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement> | undefined;
}

export function AppInput({ className, readOnly, ref, ...rest }: AppInputProps) {
  return (
    <input
      ref={ref}
      readOnly={readOnly}
      className={cn(
        "h-9 w-full rounded-xl px-3 text-sm",
        "app-focus-inset transition-shadow",
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
