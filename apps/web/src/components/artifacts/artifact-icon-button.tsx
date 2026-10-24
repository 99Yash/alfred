import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/** Square artifact control. Inside an `.app-media` overlay its tokens take the dark values. */
export function ArtifactIconButton({
  label,
  children,
  onClick,
}: {
  label: string;
  children: ReactNode;
  onClick?: (() => void) | undefined;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-control-sm transition-colors focus-visible:ring-2 focus-visible:ring-app-fg-3/40 focus-visible:outline-none",
        "text-app-fg-3 hover:bg-app-bg-a2 hover:text-app-fg-4",
      )}
    >
      {children}
    </button>
  );
}
