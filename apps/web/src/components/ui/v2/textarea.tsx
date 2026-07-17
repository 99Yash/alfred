/**
 * App-grammar Textarea primitive.
 *
 * Multi-line variant of AppInput. Same elevation shadow stack, same focus
 * halo. `card` is the default; `inline` strips chrome for embedding
 * inside a surface that owns its own outline.
 */

import type { Ref, TextareaHTMLAttributes } from "react";
import { cn } from "~/lib/utils";

export type AppTextareaVariant = "card" | "inline";

interface AppTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  variant?: AppTextareaVariant;
  ref?: Ref<HTMLTextAreaElement>;
}

export function AppTextarea({
  className,
  variant = "card",
  rows,
  readOnly,
  ref,
  ...rest
}: AppTextareaProps) {
  return (
    <textarea
      ref={ref}
      rows={rows ?? (variant === "card" ? 4 : 1)}
      readOnly={readOnly}
      className={cn(
        "block w-full resize-none rounded-2xl px-3.5 py-2.5 text-sm",
        "transition-shadow outline-none",
        "placeholder:text-app-fg-2",
        variant === "card"
          ? cn(
              "bg-app-bg-1 text-app-fg-4",
              "app-elevated",
              "focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-app-background",
              readOnly && "cursor-default bg-app-bg-2 text-app-fg-3",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )
          : cn(
              "border-0 bg-transparent p-0 text-app-fg-4",
              "focus-visible:ring-0 focus-visible:outline-none",
            ),
        className,
      )}
      {...rest}
    />
  );
}
