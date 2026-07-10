/**
 * Legacy dimension-grammar Textarea primitive for the development styleguide.
 *
 * Two patterns, both single component:
 *   - `card`   — same fill / border ramp as Input. Used in skill editor
 *                "Background" + "Prompt" fields. min-h / max-h, resize-none.
 *   - `inline` — fully transparent. Used inside chrome that owns its own
 *                outline (composer). No padding, no border, no ring.
 */

import type { Ref, TextareaHTMLAttributes } from "react";
import { cn } from "~/lib/utils";

export type LegacyTextareaVariant = "card" | "inline";

interface LegacyTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  variant?: LegacyTextareaVariant;
  ref?: Ref<HTMLTextAreaElement>;
}

const CARD = cn(
  "block w-full resize-none rounded-lg px-3 py-2 text-sm",
  "bg-[rgb(var(--gray-50)/0.5)] hover:bg-[rgb(var(--gray-50)/0.8)] focus:bg-[rgb(var(--gray-50))]",
  "border border-gray-100 hover:border-gray-200 focus:border-gray-300",
  "text-gray-950 placeholder:text-gray-800",
  "outline-none focus:outline-none",
  "transition-[background-color,border-color] duration-200",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

const INLINE = cn(
  "block w-full resize-none border-0 bg-transparent p-0",
  "text-gray-950 placeholder:text-gray-800",
  "outline-none focus-visible:ring-0 focus-visible:outline-none",
);

export function LegacyTextarea({
  className,
  variant = "card",
  rows,
  ref,
  ...rest
}: LegacyTextareaProps) {
  return (
    <textarea
      ref={ref}
      rows={rows ?? (variant === "card" ? 4 : 1)}
      className={cn(variant === "card" ? CARD : INLINE, className)}
      {...rest}
    />
  );
}
