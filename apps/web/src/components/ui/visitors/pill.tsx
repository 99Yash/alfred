/**
 * Visitors-now-grammar Pill primitive.
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

interface VsPillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
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

const TONE: Record<NonNullable<VsPillProps["tone"]>, string> = {
  green: "bg-vs-green-1 text-vs-green-4",
  red: "bg-vs-red-1 text-vs-red-4",
  amber: "bg-vs-amber-1 text-vs-amber-4",
  purple: "bg-vs-purple-1 text-vs-purple-4",
  sky: "bg-vs-sky-1 text-vs-sky-4",
  blue: "bg-vs-blue-1 text-vs-blue-4",
  pink: "bg-vs-pink-1 text-vs-pink-4",
};

export function VsPill({
  className,
  leading,
  chevron,
  variant,
  tone,
  type,
  children,
  ref,
  ...rest
}: VsPillProps) {
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
        "h-8 px-2.5 text-sm font-medium rounded-lg whitespace-nowrap",
        "transition-[box-shadow,background-color,transform]",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-vs-background",
        "vs-press",
        isAccent && tone ? TONE[tone] : cn("bg-vs-bg-1 text-vs-fg-4", "vs-elevated"),
        className,
      )}
      {...rest}
    >
      {leading ? <span className="inline-flex shrink-0 size-4">{leading}</span> : null}
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
      className="shrink-0 text-vs-fg-2"
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
