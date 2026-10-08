/** Legacy dimension Input for the styleguide. Focus shows as a border step and fill ramp, no ring. */

import type { InputHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "~/lib/utils";

type LegacyInputVariant = "default" | "search";

interface LegacyInputProps extends InputHTMLAttributes<HTMLInputElement> {
  variant?: LegacyInputVariant | undefined;
  /** Absolutely positioned; usually a 14–16px Lucide icon. */
  leading?: ReactNode | undefined;
  trailing?: ReactNode | undefined;
  ref?: Ref<HTMLInputElement> | undefined;
}

const BASE = cn(
  "block h-9 w-full text-sm",
  "bg-[rgb(var(--gray-50)/0.5)] hover:bg-[rgb(var(--gray-50)/0.8)] focus:bg-[rgb(var(--gray-50))]",
  "border border-gray-100 hover:border-gray-200 focus:border-gray-300",
  "text-gray-950 placeholder:text-gray-800",
  "outline-none focus:outline-none",
  "transition-[background-color,border-color] duration-200",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

const VARIANT = {
  default: "rounded-lg px-3 py-2",
  search: "rounded-full px-4 py-2",
} satisfies Record<LegacyInputVariant, string>;

export function LegacyInput({
  className,
  variant = "default",
  leading,
  trailing,
  ref,
  ...rest
}: LegacyInputProps) {
  if (!leading && !trailing) {
    return <input ref={ref} className={cn(BASE, VARIANT[variant], className)} {...rest} />;
  }

  /* Padding makes room for the absolutely positioned slots. */
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
}
