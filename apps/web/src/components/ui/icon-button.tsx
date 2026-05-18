/**
 * Dimension-grammar IconButton primitive.
 *
 * Square `rounded-lg` (8px), 28px or 32px. Quiet ghost styling by default.
 * Press is a snap `scale-[0.96]`. See dimension-design-reference §2.2.
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "~/lib/utils";

export type IconButtonSize = "sm" | "md";

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  /** Accessible label — also rendered as the native `title` for cursor tooltip. */
  label: string;
  size?: IconButtonSize;
  children: ReactNode;
}

const SIZE: Record<IconButtonSize, string> = {
  sm: "size-7",
  md: "size-8",
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, className, size = "md", type, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-label={label}
      title={label}
      className={cn(
        "inline-grid place-items-center rounded-lg",
        "text-gray-800 hover:text-gray-900 hover:bg-gray-100",
        "active:scale-[0.96] transition-[transform,color,background-color] duration-150",
        "outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-0",
        "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent",
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
