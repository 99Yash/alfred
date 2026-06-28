/**
 * Dimension-grammar StatusDot primitive.
 *
 * Tiny glowing dot used as a presence/health indicator. Four tones:
 *   - emerald — "Auto" pill in the composer (active workflow)
 *   - amber   — warning / pending
 *   - red     — error / disconnected
 *   - muted   — idle / no signal
 *
 * Two sizes:
 *   - md (2.5) — the canonical Dimension composer dot
 *   - sm (1.5) — Alfred-specific health dot
 */

import { type HTMLAttributes } from "react";
import { cn } from "~/lib/utils";

export type StatusTone = "emerald" | "amber" | "red" | "muted";
export type StatusSize = "sm" | "md";

interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: StatusTone;
  size?: StatusSize;
}

const TONE: Record<StatusTone, string> = {
  emerald:
    "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.55),inset_0_1px_0_rgba(255,255,255,0.4)]",
  amber: "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.55),inset_0_1px_0_rgba(255,255,255,0.4)]",
  red: "bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.55),inset_0_1px_0_rgba(255,255,255,0.4)]",
  muted: "bg-white/50 shadow-[0_0_6px_rgba(255,255,255,0.25),inset_0_1px_0_rgba(255,255,255,0.4)]",
};

const SIZE: Record<StatusSize, string> = {
  sm: "size-1.5",
  md: "size-2.5",
};

export function StatusDot({ tone = "emerald", size = "md", className, ...rest }: StatusDotProps) {
  return (
    <span
      aria-hidden
      className={cn("inline-block shrink-0 rounded-full", TONE[tone], SIZE[size], className)}
      {...rest}
    />
  );
}
