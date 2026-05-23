import { CheckCircle2, type LucideIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { TOOL_TONE, type ToolTone } from "./helpers";

export function ToolRow({
  icon: Icon,
  tone,
  label,
  detail,
  count,
  done = false,
}: {
  icon: LucideIcon;
  tone: ToolTone;
  label: string;
  detail?: string;
  count?: string;
  done?: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 text-sm leading-5">
      <span
        aria-hidden
        className={cn(
          "size-6 shrink-0 inline-flex items-center justify-center rounded-md",
          TOOL_TONE[tone],
        )}
      >
        <Icon size={12} />
      </span>
      <span className="min-w-0 truncate text-vs-fg-4 font-medium">{label}</span>
      {detail ? (
        <span className="hidden sm:inline truncate text-xs text-vs-fg-2 max-w-[28ch]">
          {detail}
        </span>
      ) : null}
      <span className="ml-auto flex items-center gap-1.5 shrink-0">
        {count ? <span className="text-xs text-vs-fg-3 tabular-nums">{count}</span> : null}
        {done ? <CheckCircle2 size={13} aria-hidden className="text-vs-green-4" /> : null}
      </span>
    </div>
  );
}

export function SearchRow(props: Omit<React.ComponentProps<typeof ToolRow>, "done">) {
  return <ToolRow {...props} done />;
}
