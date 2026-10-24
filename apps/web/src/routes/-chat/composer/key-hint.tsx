import type { ReactNode } from "react";
import { Kbd } from "~/components/ui/kbd";
import { cn } from "~/lib/utils";

/** A Kbd chip and the action it runs, e.g. `⌘↵ Steer`, for the light composer surfaces. */
export function KeyHint({
  keys,
  children,
  className,
  kbdClassName,
}: {
  keys: string;
  children: ReactNode;
  className?: string | undefined;
  kbdClassName?: string | undefined;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <Kbd className={kbdClassName}>{keys}</Kbd>
      {children}
    </span>
  );
}
