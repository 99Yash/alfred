/**
 * Dimension-grammar Avatar primitive.
 *
 * Two flavors, one component:
 *   - default — radial-gradient pseudo-avatar, no initial. 16px in the
 *               model picker. Used wherever a real image would be overkill.
 *   - initial — same disc + a single letter centered in white-ish. 28px in
 *               the sidebar user row.
 *
 * Recipe pulled from dimension-design-reference-2026-05-18.md §2.13.
 */

import type { HTMLAttributes, Ref } from "react";
import { cn } from "~/lib/utils";

export type AvatarSize = "sm" | "md" | "lg";

interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  /** When provided, the first character is rendered inside the disc. */
  initial?: string;
  size?: AvatarSize;
  ref?: Ref<HTMLSpanElement>;
}

const SIZE: Record<AvatarSize, string> = {
  sm: "size-4 text-[8px]",
  md: "size-7 text-[12px]",
  lg: "size-9 text-sm",
};

export function Avatar({ className, initial, size = "md", ref, ...rest }: AvatarProps) {
  return (
    <span
      ref={ref}
      className={cn(
        "inline-grid place-items-center rounded-full font-medium text-white/90 select-none",
        "bg-[radial-gradient(circle_at_30%_30%,#a5a5a5,#1e1e1e_70%)]",
        "shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.12),inset_0_-1px_0_rgba(0,0,0,0.4)]",
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {initial ? initial.charAt(0).toUpperCase() : null}
    </span>
  );
}
