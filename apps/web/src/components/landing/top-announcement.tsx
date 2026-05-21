import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * Top pill banner — fixed at top-center, backdrop-blurred. The dot is a
 * status indicator. The arrow icon translates on hover (group-hover).
 */
export function TopAnnouncement({
  children,
  href,
  dotClassName = "bg-amber-200/70",
  className,
}: {
  children: ReactNode;
  href: string;
  dotClassName?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "fixed inset-x-0 z-50 top-3 sm:top-5 mx-auto w-fit max-w-[92vw] sm:max-w-none",
        "pointer-events-none",
        className,
      )}
    >
      <a
        href={href}
        className={cn(
          "pointer-events-auto group relative flex items-center gap-2 sm:gap-2.5",
          "rounded-full px-3 py-1.5 sm:px-3.5 text-[12px] sm:text-[12.5px]",
          "text-white/85 hover:text-white",
          // blur layer as :before so it doesn't fight transitions on text
          "before:absolute before:inset-0 before:-z-10 before:rounded-full",
          "before:bg-black/30 before:backdrop-blur-md hover:before:bg-black/40",
          "ring-1 ring-inset ring-white/10 hover:ring-white/20",
          "transition-all duration-200",
        )}
      >
        <span aria-hidden className={cn("size-1 shrink-0 rounded-full", dotClassName)} />
        <span className="whitespace-nowrap">{children}</span>
        <span
          aria-hidden
          className="text-white/55 transition-transform group-hover:translate-x-0.5 group-hover:text-white/80"
        >
          →
        </span>
      </a>
    </div>
  );
}
