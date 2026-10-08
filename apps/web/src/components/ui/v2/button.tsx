/**
 * App Button (archive/visitors-now/design-notes.md §"Button").
 * Identity comes from `app-elevated`, `app-press`, and `app-focus`; variants change fill and text only.
 */

import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "~/lib/utils";

type AppButtonVariant =
  | "primary" /* brand CTA */
  | "white" /* neutral ink, flips with theme */
  | "ghost" /* transparent until hover */
  | "destructive"; /* red-4 */

type AppButtonSize = "sm" | "md" | "lg";

interface AppButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: AppButtonVariant | undefined;
  size?: AppButtonSize | undefined;
  leading?: ReactNode | undefined;
  trailing?: ReactNode | undefined;
  /** Disables the button and swaps the leading icon for the shared spinner. */
  loading?: boolean | undefined;
  ref?: Ref<HTMLButtonElement> | undefined;
}

/* Matches the 13/14px `leading` icons, so the swap does not resize the button. */
const SPINNER_SIZE = { sm: 13, md: 14, lg: 14 } satisfies Record<AppButtonSize, number>;

/* 12px on a 28px `sm` button looks like a pill, so small buttons get a smaller radius. */
const SIZE = {
  sm: "h-7 px-2.5 text-[13px] gap-1.5 rounded-[9px]",
  md: "h-8 px-2.5 text-sm gap-2 rounded-[10px]",
  lg: "h-9 px-3 text-sm gap-2 rounded-xl",
} satisfies Record<AppButtonSize, string>;

const VARIANT = {
  primary: cn(
    "text-[var(--app-accent-fg)]",
    /* Theme-aware: brand gradient in light, ink chip in dark. */
    "bg-[image:var(--app-cta-bg)]",
    /* Theme-aware: accent bloom in light, inset bevel in dark. */
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
} satisfies Record<AppButtonVariant, string>;

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
      // `disabled` says it cannot be pressed; `aria-busy` says the press is in progress.
      aria-busy={loading || undefined}
      className={cn(
        "relative isolate inline-flex items-center justify-center",
        "font-medium whitespace-nowrap select-none",
        /* Durations pair with this property order: fills tween 300ms, transform 150ms. */
        "transition-[filter,background-color,box-shadow,transform] ease-out",
        "[transition-duration:300ms,300ms,300ms,150ms]",
        "app-focus app-press",
        SIZE[size],
        VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {/* Spinner takes the leading slot, so the label does not shift. */}
      {loading ? (
        <span className="inline-flex shrink-0">
          <Loader2 size={SPINNER_SIZE[size]} className="animate-spin" aria-hidden />
        </span>
      ) : leading ? (
        <span className="inline-flex shrink-0">{leading}</span>
      ) : null}
      {children}
      {trailing ? <span className="inline-flex shrink-0">{trailing}</span> : null}
    </button>
  );
}
