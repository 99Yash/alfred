/**
 * Dimension-grammar FrostPanel primitive.
 *
 * Thin React wrapper around the `.frost-panel` CSS class declared in
 * `apps/web/src/index.css`. Used for tables, code blocks, structured agent
 * output, and other "lifted" surfaces. Holds a hairline + inset glow that
 * make the panel read as floating above the body bg.
 *
 * Recipe pulled from dimension-design-reference-2026-05-18.md §2.8.
 */

import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "~/lib/utils";

export const FrostPanel = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function FrostPanel({ className, ...rest }, ref) {
    return (
      <div
        ref={ref}
        className={cn("frost-panel rounded-2xl p-3", className)}
        {...rest}
      />
    );
  },
);
