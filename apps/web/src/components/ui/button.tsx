/**
 * Dimension-grammar Button primitive.
 *
 * One pill shape (`rounded-full`) for every text button; icon-only buttons
 * are square and `rounded-lg`. Variants change fill + inset glow only.
 * Recipes pulled from dimension-design-reference-2026-05-18.md §2.1.
 *
 * IMPORTANT: This is the new primitive. The legacy ad-hoc Button in
 * apps/web/src/lib/ui.tsx is kept for now so existing routes don't break;
 * migrate each route to this component during its Stage 2 pass.
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "~/lib/utils";

export type ButtonVariant =
  | "primary" /* purple gradient — the default CTA */
  | "white" /* white gradient — high-emphasis non-brand CTA (Upgrade Plan) */
  | "destructive" /* red gradient — Logout, Delete */
  | "ghost" /* translucent white-on-dark — Manage / Connect / Share */
  | "send"; /* gray→white disk — composer send affordance */

export type ButtonSize = "sm" | "md" | "mdPlus" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Optional leading icon. */
  leading?: ReactNode;
  /** Optional trailing icon or chip (e.g., ⌘↵). */
  trailing?: ReactNode;
  /** Override the loading data attribute used to fade text + show spinner. */
  loading?: boolean;
}

/* Sizes — heights and horizontal padding pulled from the recon doc. */
const SIZE: Record<ButtonSize, string> = {
  sm: "h-7 px-3 text-[13px] gap-1.5",
  md: "h-8 px-3.5 text-sm gap-1.5",
  mdPlus: "h-9 px-4 text-sm gap-2",
  lg: "h-10 px-4 text-sm gap-2",
};

/* Variants. Each row is a complete recipe: fill, text, glow, hover, active.
 * The `frost-border` class is added via the wrapper (variants opt in below). */
const VARIANT: Record<ButtonVariant, string> = {
  primary: cn(
    /* fill */
    "bg-gradient-to-b from-[#5d44df] to-[#4f37cb]",
    /* text */
    "text-white",
    /* hover/active — frost-border CSS handles the inset glow; this adds a
     * subtle brightness lift on hover for the gradient itself. */
    "hover:brightness-[1.05] active:brightness-[0.95]",
    /* disabled */
    "disabled:brightness-75 disabled:text-[#e0e0e0]",
    /* frost */
    "frost-border",
  ),

  white: cn(
    "bg-gradient-to-b from-white/85 to-[#eeeeee]",
    "text-black",
    "hover:brightness-[1.02] active:brightness-[0.97]",
    "disabled:brightness-95 disabled:saturate-50",
    "frost-border [--frost-strength:0.8] [--frost-border-strength:3]",
  ),

  destructive: cn(
    "bg-gradient-to-b from-[#dc2626] to-[#b91c1c]",
    "text-white",
    "hover:brightness-[1.06] active:brightness-[0.95]",
    "disabled:brightness-75",
    "frost-border [--frost-strength:0.7]",
  ),

  ghost: cn(
    "bg-white/[0.05] text-gray-800",
    "hover:bg-white/[0.08] hover:text-gray-900",
    "active:bg-white/[0.03]",
    "disabled:bg-gray-100 disabled:text-gray-700",
  ),

  send: cn(
    /* gray→white disk used on the composer send button */
    "bg-gradient-to-b from-[#a5a5a5] to-[#e3e3e3] from-[46%] to-[100%]",
    "text-black",
    "hover:brightness-[1.08] active:brightness-[1.04]",
    "disabled:opacity-50",
    "frost-border [--frost-strength:0.6]",
  ),
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant = "primary",
    size = "lg",
    leading,
    trailing,
    loading,
    type,
    children,
    disabled,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={disabled || loading}
      data-loading={loading || undefined}
      className={cn(
        /* base — pill shape, font weight, transition, focus ring */
        "relative inline-flex items-center justify-center isolate",
        "rounded-full font-medium whitespace-nowrap select-none",
        "transition-[filter,background-color,box-shadow] duration-200",
        "outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-0",
        "disabled:cursor-not-allowed",
        /* loading — fade text while keeping height stable */
        "data-[loading=true]:cursor-wait data-[loading=true]:text-transparent",
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
});
