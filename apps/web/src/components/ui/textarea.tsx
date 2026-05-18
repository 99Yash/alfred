/**
 * Dimension-grammar Textarea primitive.
 *
 * Two patterns, both single component:
 *   - `card`   — same fill / border ramp as Input. Used in skill editor
 *                "Background" + "Prompt" fields. min-h / max-h, resize-none.
 *   - `inline` — fully transparent. Used inside chrome that owns its own
 *                outline (composer). No padding, no border, no ring.
 *
 * Recipe pulled from dimension-design-reference-2026-05-18.md §2.4.
 */

import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "~/lib/utils";

export type TextareaVariant = "card" | "inline";

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  variant?: TextareaVariant;
}

const CARD = cn(
  "block w-full text-sm rounded-lg px-3 py-2 resize-none",
  "bg-[rgb(var(--gray-50)/0.5)] hover:bg-[rgb(var(--gray-50)/0.8)] focus:bg-[rgb(var(--gray-50))]",
  "border border-gray-100 hover:border-gray-200 focus:border-gray-300",
  "text-gray-950 placeholder:text-gray-800",
  "outline-none focus:outline-none",
  "transition-[background-color,border-color] duration-200",
  "disabled:opacity-50 disabled:cursor-not-allowed",
);

const INLINE = cn(
  "block w-full bg-transparent border-0 p-0 resize-none",
  "text-gray-950 placeholder:text-gray-800",
  "outline-none focus-visible:outline-none focus-visible:ring-0",
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ className, variant = "card", rows, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        rows={rows ?? (variant === "card" ? 4 : 1)}
        className={cn(variant === "card" ? CARD : INLINE, className)}
        {...rest}
      />
    );
  },
);
