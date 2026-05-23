import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export function IconButton({
  label,
  children,
  onClick,
  active = false,
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={onClick ? active : undefined}
      onClick={onClick}
      className={cn(
        "size-8 inline-flex items-center justify-center rounded-lg",
        "transition-colors vs-press",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
        active
          ? "bg-vs-bg-2 text-vs-fg-4 hover:bg-vs-bg-a2"
          : "text-vs-fg-3 hover:bg-vs-bg-a2 hover:text-vs-fg-4",
      )}
    >
      {children}
    </button>
  );
}
