/**
 * Dimension-grammar IconButton primitive.
 *
 * Square `rounded-lg` (8px), 28px or 32px. Quiet ghost styling by default.
 * Press is a snap `scale-[0.96]`.
 */

import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "~/lib/utils";

export type IconButtonSize = "sm" | "md";

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  /** Accessible label — also rendered as the native `title` for cursor tooltip. */
  label: string;
  size?: IconButtonSize;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

const SIZE: Record<IconButtonSize, string> = {
  sm: "size-7",
  md: "size-8",
};

export function IconButton({
  label,
  className,
  size = "md",
  type,
  children,
  ref,
  ...rest
}: IconButtonProps) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-label={label}
      title={label}
      className={cn(
        "inline-grid place-items-center rounded-lg",
        "text-gray-800 hover:bg-gray-100 hover:text-gray-900",
        "transition-[transform,color,background-color] duration-150 active:scale-[0.96]",
        "outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-0",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
