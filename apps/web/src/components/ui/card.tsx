/**
 * Dimension-grammar Card primitive.
 *
 * Plain work surface used for every list row in /integrations, /workflows,
 * /skills, /library. Rounded-2xl, transparent at rest, fills to `#181818`
 * on hover OR focus-visible (same value — no ring). Pass `interactive` when
 * the entire card is clickable so the hover transition + focus state apply.
 *
 * Recipe pulled from dimension-design-reference-2026-05-18.md §2.8.
 */

import type { HTMLAttributes, Ref } from "react";
import { cn } from "~/lib/utils";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Apply hover/focus background fill — set to true when the card itself is clickable. */
  interactive?: boolean;
  ref?: Ref<HTMLDivElement>;
}

export function Card({ className, interactive, ref, ...rest }: CardProps) {
  return (
    <div
      ref={ref}
      className={cn(
        "relative w-full rounded-2xl p-3 text-sm text-gray-800",
        "transition-[background-color] duration-200",
        interactive &&
          cn(
            "hover:bg-[#181818] focus-visible:bg-[#181818]",
            "outline-none focus-visible:outline-none cursor-pointer",
          ),
        className,
      )}
      {...rest}
    />
  );
}
