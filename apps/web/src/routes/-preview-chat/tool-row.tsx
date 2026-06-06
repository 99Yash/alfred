import { CheckCircle2, type LucideIcon } from "lucide-react";
import { IntegrationGlyph, type IntegrationBrand } from "~/lib/integration-icons";
import { cn } from "~/lib/utils";
import { TOOL_TONE, type ToolTone } from "./helpers";

/**
 * One step in a `RunGroup` — a tool/integration call, search, or write.
 *
 * Two visual modes:
 *  - `integration`: brand-colored SVG (Gmail/Calendar/Slack/…) on a neutral
 *    chip. Use whenever the row represents a call against a connected
 *    integration so the user recognizes the source at a glance.
 *  - `icon` + `tone`: Lucide icon on a toned chip. Use for internal Alfred
 *    actions (memory recall, sender resolution, tag/label writes that aren't
 *    integration-scoped).
 */
type ToolRowProps =
  | {
      integration: IntegrationBrand;
      icon?: LucideIcon;
      tone?: ToolTone;
      label: string;
      detail?: string;
      count?: string;
      done?: boolean;
    }
  | {
      integration?: undefined;
      icon: LucideIcon;
      tone: ToolTone;
      label: string;
      detail?: string;
      count?: string;
      done?: boolean;
    };

export function ToolRow(props: ToolRowProps) {
  const { label, detail, count, done = false } = props;
  return (
    <div className="flex items-center gap-2.5 text-sm leading-5">
      {props.integration ? (
        <span
          aria-hidden
          className="size-6 shrink-0 inline-flex items-center justify-center rounded-md bg-app-bg-2"
        >
          <IntegrationGlyph brand={props.integration} size={14} />
        </span>
      ) : (
        <span
          aria-hidden
          className={cn(
            "size-6 shrink-0 inline-flex items-center justify-center rounded-md",
            TOOL_TONE[props.tone],
          )}
        >
          <props.icon size={12} />
        </span>
      )}
      <span className="min-w-0 truncate text-app-fg-4 font-medium">{label}</span>
      {detail ? (
        <span className="hidden sm:inline truncate text-xs text-app-fg-2 max-w-[28ch]">
          {detail}
        </span>
      ) : null}
      <span className="ml-auto flex items-center gap-1.5 shrink-0">
        {count ? <span className="text-xs text-app-fg-3 tabular-nums">{count}</span> : null}
        {done ? <CheckCircle2 size={13} aria-hidden className="text-app-green-4" /> : null}
      </span>
    </div>
  );
}

export function SearchRow(props: Omit<ToolRowProps, "done">) {
  return <ToolRow {...(props as ToolRowProps)} done />;
}
