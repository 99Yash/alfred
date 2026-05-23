import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import { TOOL_TONE, type ToolTone } from "./helpers";

interface SourceItem {
  icon: LucideIcon;
  label: string;
  count: number;
  tone: ToolTone;
}

export function SourcesRow({ items }: { items: SourceItem[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      <span className="text-[11px] uppercase tracking-tight text-vs-fg-2 mr-1">Sources</span>
      {items.map((item) => (
        <SourcePill
          key={item.label}
          icon={<item.icon size={11} />}
          label={item.label}
          count={item.count}
          tone={item.tone}
        />
      ))}
    </div>
  );
}

function SourcePill({
  icon,
  label,
  count,
  tone,
}: {
  icon: ReactNode;
  label: string;
  count: number;
  tone: ToolTone;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg h-6 px-2 text-[11px] font-medium",
        TOOL_TONE[tone],
      )}
    >
      {icon}
      {label}
      <span className="text-vs-fg-2 tabular-nums">{count}</span>
    </span>
  );
}
