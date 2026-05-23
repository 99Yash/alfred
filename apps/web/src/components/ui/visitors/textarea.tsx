/**
 * Visitors-now-grammar Textarea primitive.
 *
 * Multi-line variant of VsInput. Same elevation shadow stack, same focus
 * halo. `card` is the default; `inline` strips chrome for embedding
 * inside a surface that owns its own outline.
 */

import type { Ref, TextareaHTMLAttributes } from "react";
import { cn } from "~/lib/utils";

export type VsTextareaVariant = "card" | "inline";

interface VsTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  variant?: VsTextareaVariant;
  ref?: Ref<HTMLTextAreaElement>;
}

export function VsTextarea({
  className,
  variant = "card",
  rows,
  readOnly,
  ref,
  ...rest
}: VsTextareaProps) {
  return (
    <textarea
      ref={ref}
      rows={rows ?? (variant === "card" ? 4 : 1)}
      readOnly={readOnly}
      className={cn(
        "block w-full text-sm rounded-2xl px-3.5 py-2.5 resize-none",
        "outline-none transition-shadow",
        "placeholder:text-vs-fg-2",
        variant === "card"
          ? cn(
              "bg-vs-bg-1 text-vs-fg-4",
              "vs-elevated",
              "focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-vs-background",
              readOnly && "bg-vs-bg-2 text-vs-fg-3 cursor-default",
              "disabled:opacity-60 disabled:cursor-not-allowed",
            )
          : cn(
              "bg-transparent text-vs-fg-4 border-0 p-0",
              "focus-visible:outline-none focus-visible:ring-0",
            ),
        className,
      )}
      {...rest}
    />
  );
}
