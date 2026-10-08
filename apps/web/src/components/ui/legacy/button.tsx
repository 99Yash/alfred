/** Legacy dimension Button. Only the error fallback and the styleguide use it; the app uses AppButton. */

import type { ButtonHTMLAttributes, Ref, ReactNode } from "react";
import { cn } from "~/lib/utils";

type LegacyButtonVariant =
  | "primary" /* purple gradient */
  | "white" /* white gradient */
  | "destructive" /* red gradient */
  | "ghost" /* translucent white-on-dark */
  | "send"; /* gray-to-white disk for the composer */

type LegacyButtonSize = "sm" | "md" | "mdPlus" | "lg";

interface LegacyButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: LegacyButtonVariant | undefined;
  size?: LegacyButtonSize | undefined;
  leading?: ReactNode | undefined;
  trailing?: ReactNode | undefined;
  /** Fades the text and shows the spinner. */
  loading?: boolean | undefined;
  ref?: Ref<HTMLButtonElement> | undefined;
}

const SIZE = {
  sm: "h-7 px-3 text-[13px] gap-1.5",
  md: "h-8 px-3.5 text-sm gap-1.5",
  mdPlus: "h-9 px-4 text-sm gap-2",
  lg: "h-10 px-4 text-sm gap-2",
} satisfies Record<LegacyButtonSize, string>;

const VARIANT = {
  primary: cn(
    "bg-linear-to-b from-[#5d44df] to-[#4f37cb]",
    "text-white",
    "hover:brightness-[1.05] active:brightness-[0.95]",
    "disabled:text-[#e0e0e0] disabled:brightness-75",
    "frost-border",
  ),

  white: cn(
    "bg-linear-to-b from-white/85 to-[#eeeeee]",
    "text-black",
    "hover:brightness-[1.02] active:brightness-[0.97]",
    "disabled:brightness-95 disabled:saturate-50",
    "frost-border [--frost-border-strength:3] [--frost-strength:0.8]",
  ),

  destructive: cn(
    "bg-linear-to-b from-[#dc2626] to-[#b91c1c]",
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
    "bg-linear-to-b from-[#a5a5a5] from-[46%] to-[#e3e3e3] to-[100%]",
    "text-black",
    "hover:brightness-[1.08] active:brightness-[1.04]",
    "disabled:opacity-50",
    "frost-border [--frost-strength:0.6]",
  ),
} satisfies Record<LegacyButtonVariant, string>;

export function LegacyButton({
  className,
  variant = "primary",
  size = "lg",
  leading,
  trailing,
  loading,
  type,
  children,
  disabled,
  ref,
  ...rest
}: LegacyButtonProps) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={disabled || loading}
      data-loading={loading || undefined}
      className={cn(
        "relative isolate inline-flex items-center justify-center",
        "rounded-full font-medium whitespace-nowrap select-none",
        "transition-[filter,background-color,box-shadow] duration-200",
        "outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-0",
        "disabled:cursor-not-allowed",
        /* fade text, keep height */
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
}
