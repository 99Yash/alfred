/** Small glowing presence/health dot. */

import { type HTMLAttributes } from "react";
import { cn } from "~/lib/utils";

type StatusTone = "emerald" | "amber" | "red" | "muted";

type StatusSize = "sm" | "md";

interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: StatusTone | undefined;
  size?: StatusSize | undefined;
}

const TONE = {
  emerald:
    "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.55),inset_0_1px_0_rgba(255,255,255,0.4)]",
  amber: "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.55),inset_0_1px_0_rgba(255,255,255,0.4)]",
  red: "bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.55),inset_0_1px_0_rgba(255,255,255,0.4)]",
  muted: "bg-white/50 shadow-[0_0_6px_rgba(255,255,255,0.25),inset_0_1px_0_rgba(255,255,255,0.4)]",
} satisfies Record<StatusTone, string>;

const SIZE = {
  sm: "size-1.5",
  md: "size-2.5",
} satisfies Record<StatusSize, string>;

export function StatusDot({ tone = "emerald", size = "md", className, ...rest }: StatusDotProps) {
  return (
    <span
      aria-hidden
      className={cn("inline-block shrink-0 rounded-full", TONE[tone], SIZE[size], className)}
      {...rest}
    />
  );
}
