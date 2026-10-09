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
      <Kbd className={cn("border-app-fg-a1/40 bg-app-bg-1 text-app-fg-3", kbdClassName)}>
        {keys}
      </Kbd>
      {children}
    </span>
  );
}
