import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * Forwards its ref and spreads extra props so it can sit inside a Radix
 * `Tooltip.Trigger asChild` (which injects pointer handlers + a ref).
 */
export const IconButton = forwardRef<
  HTMLButtonElement,
  {
    label: string;
    children: ReactNode;
    onClick?: () => void;
    active?: boolean;
  } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick">
>(function IconButton({ label, children, onClick, active = false, className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={onClick ? active : undefined}
      onClick={onClick}
      className={cn(
        "size-8 inline-flex items-center justify-center rounded-lg",
        "transition-colors app-press",
        "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
        active
          ? "bg-app-bg-2 text-app-fg-4 hover:bg-app-bg-a2"
          : "text-app-fg-3 hover:bg-app-bg-a2 hover:text-app-fg-4",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
