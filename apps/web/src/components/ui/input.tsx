/**
 * Dimension-grammar Input primitive.
 *
 * Two visual variants:
 *   - `default` — rounded-lg, used in forms (skill editor, settings).
 *   - `search`  — rounded-full, optional leading icon, used on /integrations.
 *
 * Background ramps from `gray-50 @ 50%` (default) through `gray-50 @ 80%` (hover)
 * to fully opaque on focus. Border steps gray-100 → gray-200 → gray-300.
 * No outline ring — focus is signalled by the border step + fill ramp.
 *
 * Recipe pulled from dimension-design-reference-2026-05-18.md §2.3.
 */

import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "~/lib/utils";

export type InputVariant = "default" | "search";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  variant?: InputVariant;
  /** Leading slot — typically a 14–16px Lucide icon. Slot is absolutely positioned. */
  leading?: ReactNode;
  /** Trailing slot — small icon or kbd hint. */
  trailing?: ReactNode;
}

const BASE = cn(
  /* layout */
  "block w-full h-9 text-sm",
  /* fill ramp via state */
  "bg-[rgb(var(--gray-50)/0.5)] hover:bg-[rgb(var(--gray-50)/0.8)] focus:bg-[rgb(var(--gray-50))]",
  /* border step */
  "border border-gray-100 hover:border-gray-200 focus:border-gray-300",
  /* text */
  "text-gray-950 placeholder:text-gray-800",
  /* no ring — Dimension uses the border step instead */
  "outline-none focus:outline-none",
  /* transitions */
  "transition-[background-color,border-color] duration-200",
  /* disabled */
  "disabled:opacity-50 disabled:cursor-not-allowed",
);

const VARIANT: Record<InputVariant, string> = {
  default: "rounded-lg px-3 py-2",
  search: "rounded-full px-4 py-2",
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, variant = "default", leading, trailing, ...rest },
  ref,
) {
  /* Bare input — most usage. */
  if (!leading && !trailing) {
    return <input ref={ref} className={cn(BASE, VARIANT[variant], className)} {...rest} />;
  }

  /* Slotted input — wrap in a relative container so we can absolutely position
   * the leading/trailing icons over the input padding. Padding compensates. */
  return (
    <div className={cn("relative inline-flex w-full items-center")}>
      {leading ? (
        <span className="pointer-events-none absolute left-3 inline-flex text-gray-800">
          {leading}
        </span>
      ) : null}
      <input
        ref={ref}
        className={cn(BASE, VARIANT[variant], leading && "pl-9", trailing && "pr-9", className)}
        {...rest}
      />
      {trailing ? (
        <span className="absolute right-3 inline-flex text-gray-800">{trailing}</span>
      ) : null}
    </div>
  );
});
