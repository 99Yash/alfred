import type { ComponentType, ReactNode } from "react";
import { VsCard } from "~/components/ui/visitors";
import { cn } from "~/lib/utils";

type CardTone = "purple" | "amber" | "sky" | "green" | "pink" | "orange" | "red" | "neutral";

const CARD_TILE: Record<CardTone, string> = {
  purple: "bg-vs-purple-1 text-vs-purple-4",
  amber: "bg-vs-amber-1 text-vs-amber-4",
  sky: "bg-vs-sky-1 text-vs-sky-4",
  green: "bg-vs-green-1 text-vs-green-4",
  pink: "bg-vs-pink-1 text-vs-pink-4",
  orange: "bg-vs-orange-1 text-vs-orange-4",
  red: "bg-vs-red-1 text-vs-red-4",
  neutral: "bg-vs-bg-2 text-vs-fg-3",
};

interface SettingCardProps {
  title: string;
  description?: string;
  /** Optional hue-tinted icon tile next to the title. */
  icon?: ComponentType<{ size?: number; className?: string }>;
  tone?: CardTone;
  /** Optional footer caption (left side, below the divider). */
  footer?: ReactNode;
  /** Optional footer action (right side, below the divider). */
  action?: ReactNode;
  /** When true, the footer divider is omitted. */
  noDivider?: boolean;
  children?: ReactNode;
}

export function SettingCard({
  title,
  description,
  icon: Icon,
  tone = "neutral",
  footer,
  action,
  noDivider,
  children,
}: SettingCardProps) {
  return (
    <VsCard padded={false}>
      <div className="flex items-start gap-3 p-5 pb-3">
        {Icon ? (
          <span
            aria-hidden
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-xl mt-0.5",
              CARD_TILE[tone],
            )}
          >
            <Icon size={14} />
          </span>
        ) : null}
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium text-vs-fg-4">{title}</p>
          {description ? <p className="text-xs text-vs-fg-3">{description}</p> : null}
        </div>
      </div>
      {children ? (
        <div className={cn("pb-3", Icon ? "px-5 pl-[60px]" : "px-5")}>{children}</div>
      ) : null}
      {footer || action ? (
        <div
          className={cn(
            "flex items-center justify-between px-5 py-3",
            !noDivider && "border-t border-vs-bg-2",
          )}
        >
          <p className="text-xs text-vs-fg-2">{footer}</p>
          {action}
        </div>
      ) : null}
    </VsCard>
  );
}
