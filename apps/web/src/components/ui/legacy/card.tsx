/** Legacy dimension Card for the styleguide. */

import type { HTMLAttributes, Ref } from "react";
import { cn } from "~/lib/utils";

interface LegacyCardProps extends HTMLAttributes<HTMLDivElement> {
  /** Hover and focus fill, for a fully clickable card. */
  interactive?: boolean | undefined;
  ref?: Ref<HTMLDivElement> | undefined;
}

export function LegacyCard({ className, interactive, ref, ...rest }: LegacyCardProps) {
  return (
    <div
      ref={ref}
      className={cn(
        "relative w-full rounded-2xl p-3 text-sm text-gray-800",
        "transition-[background-color] duration-200",
        interactive &&
          cn(
            "hover:bg-[#181818] focus-visible:bg-[#181818]",
            "cursor-pointer outline-none focus-visible:outline-none",
          ),
        className,
      )}
      {...rest}
    />
  );
}
