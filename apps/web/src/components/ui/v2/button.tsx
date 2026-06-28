/**
 * App-grammar Button primitive.
 *
 * Recipe pulled from archive/visitors-now/design-notes.md §"Button".
 * The visual identity is in three places:
 *   1. `app-elevated` — two-shadow stack (1px drop + 0-blur hairline).
 *   2. `app-press`    — active:scale-99 microinteraction.
 *   3. `focus-visible:ring-2 ring-app-purple-2 ring-offset-4` — soft purple halo.
 *
 * No gradients, no border property, no glow. The shadow does everything.
 * Variants change fill + text color only.
 */

import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "~/lib/utils";

export type AppButtonVariant =
  | "primary" /* solid purple-4 — the brand CTA */
  | "white" /* elevated white pill — the default visitors.now button */
  | "ghost" /* transparent until hover, then bg-a2 */
  | "destructive"; /* solid red-4 */

export type AppButtonSize = "sm" | "md" | "lg";

interface AppButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: AppButtonVariant;
  size?: AppButtonSize;
  leading?: ReactNode;
  trailing?: ReactNode;
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/* Radius scales with height: 12px on a 28px-tall `sm` button reads almost
 * pill-shaped, so small buttons step down to keep corners proportional. */
const SIZE: Record<AppButtonSize, string> = {
  sm: "h-7 px-2.5 text-[13px] gap-1.5 rounded-[9px]",
  md: "h-8 px-2.5 text-sm gap-2 rounded-[10px]",
  lg: "h-9 px-3 text-sm gap-2 rounded-xl",
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
const VARIANT: Record<AppButtonVariant, string> = {
  primary: cn(
    "text-[var(--app-accent-fg)]",
    /* fill resolves through --app-cta-bg which is theme-aware:
     * light = saturated brand gradient, dark = dimension-style ink chip
     * with a faint accent-tinted top. */
    "bg-[image:var(--app-cta-bg)]",
    /* shadow resolves through --app-button-primary-shadow which is theme-aware:
     * light mode adds an accent-tinted bloom; dark mode drops it and uses
     * an inset top/bottom bevel + a tight black drop for the "embedded" feel. */
    "shadow-[var(--app-button-primary-shadow)]",
    "hover:brightness-[1.06]",
    "hover:shadow-[var(--app-button-primary-shadow-hover)]",
    "active:brightness-[0.96]",
    "disabled:cursor-not-allowed disabled:opacity-[0.85]",
    "disabled:hover:shadow-[var(--app-button-primary-shadow)] disabled:hover:brightness-100",
  ),
  white: cn(
    "bg-app-fg-4 text-app-bg-1",
    "shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_1px_2px_rgba(0,0,0,0.10)]",
    "hover:brightness-[1.05] active:brightness-[0.95]",
    "disabled:cursor-not-allowed disabled:opacity-50",
  ),
  ghost: cn(
    "bg-transparent text-app-fg-4",
    "hover:bg-app-bg-a2",
    "disabled:cursor-not-allowed disabled:opacity-50",
  ),
  destructive: cn(
    "bg-app-red-4 text-white",
    "shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_2px_rgba(0,0,0,0.18),0_8px_24px_rgba(255,47,0,0.32)]",
    "hover:brightness-[1.05]",
    "hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.20),0_2px_4px_rgba(0,0,0,0.22),0_12px_32px_rgba(255,47,0,0.42)]",
    "active:brightness-[0.96]",
    "disabled:cursor-not-allowed disabled:opacity-50",
  ),
};

export function AppButton({
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
}: AppButtonProps) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={disabled || loading}
      data-loading={loading || undefined}
      className={cn(
        "relative isolate inline-flex items-center justify-center",
        "font-medium whitespace-nowrap select-none",
        /* Hover fill/glow tweens at 300ms; transform keeps 150ms so the
         * app-press scale still feels snappy. Durations are positional —
         * they pair with the property list order. */
        "transition-[filter,background-color,box-shadow,transform] ease-out",
        "[transition-duration:300ms,300ms,300ms,150ms]",
        "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-app-background",
        "app-press",
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
