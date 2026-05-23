/**
 * Visitors-now-grammar fixed top header.
 *
 * 42px tall, fixed to the top, centered content. Uses `vs-frost-header`
 * so the backdrop blurs CONTENT below it but fades cleanly to no-blur
 * at the very top (no harsh edge between chrome and page). Children
 * render in a centered narrow column.
 */

import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

interface VsHeaderProps {
  /** Left slot — usually a logo + project switcher. */
  start?: ReactNode;
  /** Right slot — usually an avatar dropdown. */
  end?: ReactNode;
  className?: string;
}

export function VsHeader({ start, end, className }: VsHeaderProps) {
  return (
    <header
      className={cn(
        "vs-frost-header",
        "fixed top-0 left-0 right-0 z-40",
        "h-[58px] flex items-center justify-between",
        "px-4 md:px-6",
        className,
      )}
    >
      <div className="flex-1 flex items-center justify-start min-w-0">{start}</div>
      <div className="flex-1 flex items-center justify-end min-w-0">{end}</div>
    </header>
  );
}
