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

/* Recipes
 * - primary: gradient on the brand accent token, white text, a 1px white
 *   inset highlight (the "lift"), and an accent-tinted drop glow. Hover
 *   brightens + grows the glow; active darkens. Disabled keeps the
 *   gradient identity (so it still reads as "the CTA, just not yet
 *   clickable") but softens the glow and disables hover.
 * - white: ink button. Background flips with theme — black on white in
 *   light mode, white on black in dark mode — for max neutral contrast.
 * - ghost: invisible at rest.
 * - destructive: same recipe as primary on the red-4 token.
 */
const VARIANT: Record<VsButtonVariant, string> = {
  primary: cn(
    "text-[var(--vs-accent-fg)]",
    "bg-[linear-gradient(180deg,var(--vs-accent-from)_0%,var(--vs-accent-to)_100%)]",
    "shadow-[inset_0_1px_0_rgba(255,255,255,0.20),0_1px_2px_rgba(0,0,0,0.18),0_8px_24px_var(--vs-accent-glow)]",
    "hover:brightness-[1.06]",
    "hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_2px_4px_rgba(0,0,0,0.22),0_12px_32px_var(--vs-accent-glow)]",
    "active:brightness-[0.96]",
    "disabled:cursor-not-allowed",
    "disabled:hover:brightness-100 disabled:hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.20),0_1px_2px_rgba(0,0,0,0.18),0_8px_24px_var(--vs-accent-glow)]",
    "disabled:opacity-[0.85]",
  ),
  white: cn(
    "bg-vs-fg-4 text-vs-bg-1",
    "shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_1px_2px_rgba(0,0,0,0.10)]",
    "hover:brightness-[1.05] active:brightness-[0.95]",
    "disabled:opacity-50 disabled:cursor-not-allowed",
  ),
  ghost: cn(
    "bg-transparent text-vs-fg-4",
    "hover:bg-vs-bg-a2",
    "disabled:opacity-50 disabled:cursor-not-allowed",
  ),
  destructive: cn(
    "bg-vs-red-4 text-white",
    "shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_2px_rgba(0,0,0,0.18),0_8px_24px_rgba(255,47,0,0.32)]",
    "hover:brightness-[1.05]",
    "hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.20),0_2px_4px_rgba(0,0,0,0.22),0_12px_32px_rgba(255,47,0,0.42)]",
    "active:brightness-[0.96]",
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
