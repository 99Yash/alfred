/**
 * App-grammar Pill primitive.
 *
 * The 32px-tall rounded-full selector used for "Today", "30 days", "USD",
 * etc. on visitors.now. Same shadow stack as the Button white variant.
 * Optional leading icon + trailing chevron.
 *
 * Use as a button (clickable selector) or as a static chip (delta indicator,
 * status, source name). The `chevron` prop adds the up/down chevron used
 * for dropdown triggers.
 */

import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "~/lib/utils";

interface AppPillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  leading?: ReactNode;
  /** Show a chevron-down on the right edge. Set true when the pill opens a menu. */
  chevron?: boolean;
  /**
   * Default visual: muted bg. `accent` is the colored variant — left as a
   * prop for explicit call sites, but it's also inferred automatically when
   * `tone` is set, so callers only need to set one of the two.
   */
  variant?: "default" | "accent";
  /** Picks the hue family. Setting this implies the accent variant. */
  tone?: "green" | "red" | "amber" | "purple" | "sky" | "blue" | "pink";
  ref?: Ref<HTMLButtonElement>;
}

const TONE: Record<NonNullable<AppPillProps["tone"]>, string> = {
  green: "bg-app-green-1 text-app-green-4",
  red: "bg-app-red-1 text-app-red-4",
  amber: "bg-app-amber-1 text-app-amber-4",
  purple: "bg-app-purple-1 text-app-purple-4",
  sky: "bg-app-sky-1 text-app-sky-4",
  blue: "bg-app-blue-1 text-app-blue-4",
  pink: "bg-app-pink-1 text-app-pink-4",
};

export function AppPill({
  className,
  leading,
  chevron,
  variant,
  tone,
  type,
  children,
  ref,
  ...rest
}: AppPillProps) {
  // A pill is "accented" whenever a tone is provided, or the caller
  // explicitly sets variant="accent". Passing `tone` alone is the common
  // case — every caller wants the hue, so we shouldn't require both.
  const isAccent = !!tone || variant === "accent";
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(
        "inline-flex items-center justify-center gap-1.5",
        "h-8 rounded-lg px-2.5 text-sm font-medium whitespace-nowrap",
        "transition-[box-shadow,background-color,transform]",
        "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-app-background",
        "app-press",
        isAccent && tone ? TONE[tone] : cn("bg-app-bg-1 text-app-fg-4", "app-elevated"),
        className,
      )}
      {...rest}
    >
      {leading ? <span className="inline-flex size-4 shrink-0">{leading}</span> : null}
      <span>{children}</span>
      {chevron ? <ChevronUpDown /> : null}
    </button>
  );
}

function ChevronUpDown() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className="shrink-0 text-app-fg-2"
    >
      <path
        d="M3.5 5L6 2.5L8.5 5M3.5 7L6 9.5L8.5 7"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
