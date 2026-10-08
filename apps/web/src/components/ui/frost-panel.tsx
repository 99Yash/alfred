/** Wrapper for the `.frost-panel` class in index.css. */

import type { HTMLAttributes, Ref } from "react";
import { cn } from "~/lib/utils";

export function FrostPanel({
  className,
  ref,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }) {
  return <div ref={ref} className={cn("frost-panel rounded-2xl p-3", className)} {...rest} />;
}
