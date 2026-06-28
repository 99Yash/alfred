import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * Bottom-pinned floating pill navigation. The blurred background is rendered
 * as a `:before` pseudo so opacity transitions on the nav don't fight with
 * the blur layer. Pass `cta` for a slot on the right (e.g. the FrostButton).
 */
export function FloatingPillNav({
  logo,
  children,
  cta,
  className,
}: {
  logo?: ReactNode;
  children?: ReactNode;
  cta?: ReactNode;
  className?: string;
}) {
  return (
    <nav
      aria-label="Primary"
      className={cn(
        "fixed inset-x-0 bottom-4 z-50 mx-auto h-fit sm:bottom-8",
        "w-full max-w-[90vw] sm:w-fit sm:max-w-none",
        "flex items-center justify-between gap-4 rounded-full p-3",
        "before:absolute before:top-0 before:left-0 before:-z-10",
        "before:size-full before:rounded-full",
        "before:bg-black/40 before:backdrop-blur-lg",
        "transition-opacity duration-300",
        className,
      )}
    >
      {logo ? <div className="ml-2 flex items-center gap-2">{logo}</div> : null}
      {children ? (
        <>
          <div aria-hidden className="hidden h-6 w-px shrink-0 bg-white/10 sm:block" />
          <div className="hidden items-center gap-0 text-sm text-white sm:flex">{children}</div>
        </>
      ) : null}
      {cta ? <div className="shrink-0">{cta}</div> : null}
    </nav>
  );
}
