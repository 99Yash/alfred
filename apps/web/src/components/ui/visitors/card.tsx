/**
 * Visitors-now-grammar Card primitive.
 *
 * Recipe from archive/visitors-now/design-notes.md §"Card":
 *   bg-background, shadow-sm, rounded-2xl, overflow-hidden. No border.
 *
 * The dashboard panels on visitors.now are 352px wide with internal
 * padding of 20px. We expose the padding via the `padded` prop so callers
 * (KPI strips, list cards) can opt out when they need to handle their
 * own internal layout.
 */

import type { HTMLAttributes, Ref } from "react";
import { cn } from "~/lib/utils";

interface VsCardProps extends HTMLAttributes<HTMLDivElement> {
  /** Apply the default 20px padding. Default true. Set false when the card embeds its own scrolling list or chart. */
  padded?: boolean;
  /** Make the card hover/focus-respond. Use when the entire card is clickable. */
  interactive?: boolean;
  ref?: Ref<HTMLDivElement>;
}

export function VsCard({ className, padded = true, interactive, ref, ...rest }: VsCardProps) {
  return (
    <div
      ref={ref}
      className={cn(
        "w-full bg-vs-bg-1 rounded-2xl overflow-hidden",
        "shadow-[0_1px_1px_rgba(0,0,0,0.05),0_0_0_1px_rgba(0,0,0,0.05)]",
        padded && "p-5",
        interactive &&
          cn(
            "transition-shadow cursor-pointer",
            "hover:shadow-[0_1px_3px_rgba(0,0,0,0.08),0_0_0_1px_rgba(0,0,0,0.08)]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-vs-background",
          ),
        className,
      )}
      {...rest}
    />
  );
}

interface VsCardHeaderProps extends HTMLAttributes<HTMLDivElement> {
  /** Title text shown on the left. */
  title: string;
  /** Optional right-side controls — typically a TabBar-as-text or a Pill. */
  trailing?: React.ReactNode;
}

export function VsCardHeader({
  className,
  title,
  trailing,
  ref,
  ...rest
}: VsCardHeaderProps & { ref?: Ref<HTMLDivElement> }) {
  return (
    <div
      ref={ref}
      className={cn(
        "flex items-center justify-between text-sm font-medium text-vs-fg-4 mb-4",
        className,
      )}
      {...rest}
    >
      <span>{title}</span>
      {trailing ? <div className="flex items-center gap-3 text-vs-fg-2">{trailing}</div> : null}
    </div>
  );
}
