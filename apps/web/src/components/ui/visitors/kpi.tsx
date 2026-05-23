/**
 * Visitors-now-grammar KPI label.
 *
 * Three-row vertical stack: small label (with optional series dot), value
 * in the brand ink color, optional delta chip. No card chrome — KPIs
 * compose horizontally into a strip above charts.
 *
 * Recipe pulled from archive/visitors-now/design-notes.md §"KPI label".
 */

import type { HTMLAttributes, Ref } from "react";
import { cn } from "~/lib/utils";

type Tone = "green" | "red" | "amber" | "purple" | "sky" | "blue" | "pink";

interface VsKpiProps extends HTMLAttributes<HTMLDivElement> {
  /** Short label rendered in text-xs / text-fg-2. */
  label: string;
  /** Display value — usually a short number or duration. */
  value: string;
  /** Optional series indicator dot color. */
  dot?: Tone;
  /** Optional delta chip rendered below the value (e.g. "+100%"). */
  delta?: string;
  /** Picks the delta color (green for positive, red for negative). */
  deltaTone?: "green" | "red" | "neutral";
  ref?: Ref<HTMLDivElement>;
}

const DOT_BG: Record<Tone, string> = {
  green: "bg-vs-green-4",
  red: "bg-vs-red-4",
  amber: "bg-vs-amber-4",
  purple: "bg-vs-purple-4",
  sky: "bg-vs-sky-4",
  blue: "bg-vs-blue-4",
  pink: "bg-vs-pink-4",
};

const DELTA: Record<NonNullable<VsKpiProps["deltaTone"]>, string> = {
  green: "text-vs-green-4",
  red: "text-vs-red-4",
  neutral: "text-vs-fg-2",
};

export function VsKpi({ label, value, dot, delta, deltaTone = "green", className, ref, ...rest }: VsKpiProps) {
  return (
    <div ref={ref} className={cn("flex flex-col gap-0.5", className)} {...rest}>
      <div className="flex items-center gap-1.5 text-xs text-vs-fg-2 font-medium">
        <span>{label}</span>
        {dot ? <span className={cn("inline-block size-1.5 rounded-full", DOT_BG[dot])} aria-hidden /> : null}
      </div>
      <div className="text-sm/4 font-medium text-vs-fg-4 tabular-nums">{value}</div>
      {delta ? (
        <div className={cn("text-xs font-medium tabular-nums", DELTA[deltaTone])}>{delta}</div>
      ) : null}
    </div>
  );
}
