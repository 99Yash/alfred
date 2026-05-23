/**
 * Visitors-now-grammar Button primitive.
 *
 * Recipe pulled from archive/visitors-now/design-notes.md §"Button".
 * The visual identity is in three places:
 *   1. `vs-elevated` — two-shadow stack (1px drop + 0-blur hairline).
 *   2. `vs-press`    — active:scale-99 microinteraction.
 *   3. `focus-visible:ring-2 ring-vs-purple-2 ring-offset-4` — soft purple halo.
 *
 * No gradients, no border property, no glow. The shadow does everything.
 * Variants change fill + text color only.
 */

import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "~/lib/utils";

export type VsButtonVariant =
  | "primary" /* solid purple-4 — the brand CTA */
  | "white" /* elevated white pill — the default visitors.now button */
  | "ghost" /* transparent until hover, then bg-a2 */
  | "destructive"; /* solid red-4 */

export type VsButtonSize = "sm" | "md" | "lg";

interface VsButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: VsButtonVariant;
  size?: VsButtonSize;
  leading?: ReactNode;
  trailing?: ReactNode;
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

const SIZE: Record<VsButtonSize, string> = {
  sm: "h-7 px-2.5 text-[13px] gap-1.5",
  md: "h-8 px-2.5 text-sm gap-2",
  lg: "h-9 px-3 text-sm gap-2",
};

const VARIANT: Record<VsButtonVariant, string> = {
  primary: cn(
    "bg-vs-purple-4 text-white",
    "hover:brightness-[1.04] active:brightness-[0.97]",
    "shadow-[0_1px_1px_rgba(0,0,0,0.08),0_0_0_1px_rgba(0,0,0,0.05)]",
    "hover:shadow-[0_1px_1px_rgba(0,0,0,0.12),0_0_0_1px_rgba(0,0,0,0.1)]",
    "disabled:opacity-50 disabled:cursor-not-allowed",
  ),
  white: cn(
    "bg-vs-bg-1 text-vs-fg-4",
    "vs-elevated",
    "disabled:opacity-50 disabled:cursor-not-allowed",
  ),
  ghost: cn(
    "bg-transparent text-vs-fg-4",
    "hover:bg-vs-bg-a2",
    "disabled:opacity-50 disabled:cursor-not-allowed",
  ),
  destructive: cn(
    "bg-vs-red-4 text-white",
    "hover:brightness-[1.04] active:brightness-[0.97]",
    "shadow-[0_1px_1px_rgba(0,0,0,0.08),0_0_0_1px_rgba(0,0,0,0.05)]",
    "hover:shadow-[0_1px_1px_rgba(0,0,0,0.12),0_0_0_1px_rgba(0,0,0,0.1)]",
    "disabled:opacity-50 disabled:cursor-not-allowed",
  ),
};

export function VsButton({
  className,
  variant = "white",
  size = "md",
  leading,
  trailing,
  loading,
  type,
  children,
  disabled,
  ref,
  ...rest
}: VsButtonProps) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={disabled || loading}
      data-loading={loading || undefined}
      className={cn(
        "relative inline-flex items-center justify-center isolate",
        "rounded-full font-medium whitespace-nowrap select-none",
        "transition-[filter,background-color,box-shadow,transform]",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-vs-background",
        "vs-press",
        SIZE[size],
        VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {leading ? <span className="inline-flex shrink-0">{leading}</span> : null}
      {children}
      {trailing ? <span className="inline-flex shrink-0">{trailing}</span> : null}
    </button>
  );
}
