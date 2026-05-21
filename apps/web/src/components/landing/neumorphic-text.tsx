import type { CSSProperties, ReactNode } from "react";
import { cn } from "~/lib/utils";

export type NeumorphicTextColor =
  | "default"
  | "yellow"
  | "orange"
  | "blue"
  | "green"
  | "purple"
  | "black";

const COLOR_CLASS: Record<NeumorphicTextColor, string> = {
  default: "neumorphic-text-default",
  yellow: "neumorphic-text-yellow",
  orange: "neumorphic-text-orange",
  blue: "neumorphic-text-blue",
  green: "neumorphic-text-green",
  purple: "neumorphic-text-purple",
  black: "neumorphic-text-black",
};

/**
 * Engraved-metal text with a sliding colored sheen. Stagger multiple instances
 * by passing `delay` in seconds so a column of words feels orchestrated.
 */
export function NeumorphicText({
  children,
  color = "default",
  delay,
  className,
  as: As = "span",
}: {
  children: ReactNode;
  color?: NeumorphicTextColor;
  delay?: number;
  className?: string;
  as?: "span" | "p" | "h1" | "h2" | "h3";
}) {
  const style: CSSProperties = delay != null ? { animationDelay: `${delay}s` } : {};
  return (
    <As className={cn("neumorphic-text", COLOR_CLASS[color], className)} style={style}>
      {children}
    </As>
  );
}
