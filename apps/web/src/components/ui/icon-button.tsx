import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "~/lib/utils";

type IconButtonSize = "sm" | "md";

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  /** Also the native `title` tooltip. */
  label: string;
  size?: IconButtonSize | undefined;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement> | undefined;
}

const SIZE = {
  sm: "size-7",
  md: "size-8",
} satisfies Record<IconButtonSize, string>;

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
