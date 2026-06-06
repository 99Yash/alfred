import type { ComponentType, ReactNode } from "react";
import { AppCard } from "~/components/ui/v2";
import { cn } from "~/lib/utils";

type CardTone = "purple" | "amber" | "sky" | "green" | "pink" | "orange" | "red" | "neutral";

const CARD_TILE: Record<CardTone, string> = {
  purple: "bg-app-purple-1 text-app-purple-4",
  amber: "bg-app-amber-1 text-app-amber-4",
  sky: "bg-app-sky-1 text-app-sky-4",
  green: "bg-app-green-1 text-app-green-4",
  pink: "bg-app-pink-1 text-app-pink-4",
  orange: "bg-app-orange-1 text-app-orange-4",
  red: "bg-app-red-1 text-app-red-4",
  neutral: "bg-app-bg-2 text-app-fg-3",
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
    <AppCard padded={false}>
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
          <p className="text-sm font-medium text-app-fg-4">{title}</p>
          {description ? <p className="text-xs text-app-fg-3">{description}</p> : null}
        </div>
      </div>
      {children ? (
        <div className={cn("pb-3", Icon ? "px-5 pl-[60px]" : "px-5")}>{children}</div>
      ) : null}
      {footer || action ? (
        <div
          className={cn(
            "flex items-center justify-between px-5 py-3",
            !noDivider && "border-t border-app-bg-2",
          )}
        >
          <p className="text-xs text-app-fg-2">{footer}</p>
          {action}
        </div>
      ) : null}
    </AppCard>
  );
}
